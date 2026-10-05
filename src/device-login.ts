import { spawn } from 'node:child_process';
import { hostname } from 'node:os';

/**
 * Sign in through the browser (OAuth device flow, RFC 8628), so no key is ever
 * pasted into a terminal or a chat: the API hands out a code, the user confirms
 * it on www.insightsocial.app/connect/device, and the poll below receives a key
 * named after this machine ("CLI · <hostname>"). Run by `login` and by `init`
 * when there is no key yet.
 */

export const CLI_CLIENT_ID = 'insightsocial-cli';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export class DeviceLoginError extends Error {}

interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
}

export interface DeviceLoginOptions {
  baseUrl: string;
  /** Where instructions go: stderr, so stdout stays clean for scripts. */
  log: (line: string) => void;
  openBrowser?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  open?: (url: string) => void;
  deviceName?: string;
}

async function post(fetchImpl: typeof fetch, url: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
  } catch (error) {
    throw new DeviceLoginError(`Could not reach ${new URL(url).origin}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/**
 * Whether a sign-in link the server sent may be opened: https on our domain,
 * or on the configured API host (self-hosted, staging), or http on this
 * machine for local development. Anything else is printed, never launched:
 * `open` and `xdg-open` launch file: and custom-scheme URLs too.
 */
export function safeToOpen(link: string, baseUrl: string): boolean {
  let url: URL;
  let base: URL;
  try {
    url = new URL(link);
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol === 'http:') return local;
  if (url.protocol !== 'https:') return false;
  return url.hostname === 'insightsocial.app' || url.hostname.endsWith('.insightsocial.app') || url.hostname === base.hostname;
}

/** Best effort: a machine with no browser still has the printed link. */
export function openInBrowser(url: string): void {
  // Not `cmd /c start`: cmd.exe reads & and | in an unquoted argument as
  // command separators. url.dll takes the URL as data.
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The link is printed; that is the fallback.
  }
}

export interface DeviceLoginResult {
  key: string;
  /** The account that approved it, when the API says (it does for the CLI). */
  email: string | null;
}

/** Resolves with the new API key once the user clicks Allow. */
export async function deviceLogin(options: DeviceLoginOptions): Promise<DeviceLoginResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const base = options.baseUrl.replace(/\/+$/, '');

  const start = await post(fetchImpl, `${base}/oauth/device_authorization`, {
    client_id: CLI_CLIENT_ID,
    device_name: options.deviceName ?? hostname(),
  });
  if (start.status !== 200 || typeof start.body.device_code !== 'string') {
    const why = typeof start.body.error_description === 'string' ? start.body.error_description : `HTTP ${start.status}`;
    throw new DeviceLoginError(`Could not start sign-in: ${why}`);
  }
  const device = start.body as unknown as DeviceStart;
  // The page asks the user to type the code: a link with the code in it is
  // what a phisher sends, so the server no longer offers one.
  const link = device.verification_uri;

  options.log('Sign in to InsightSocial in your browser:');
  options.log(`  1. Open ${link}`);
  options.log(`  2. Enter this code: ${device.user_code}`);
  if (options.openBrowser !== false) {
    if (safeToOpen(link, base)) (options.open ?? openInBrowser)(link);
    else options.log('  (The server sent an unexpected sign-in address, so it was not opened. Check it before you open it.)');
  }
  options.log('Waiting for you to click Allow…');

  let interval = Math.max(1, device.interval ?? 5) * 1000;
  const deadline = Date.now() + device.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const poll = await post(fetchImpl, `${base}/oauth/token`, {
      grant_type: DEVICE_GRANT,
      device_code: device.device_code,
      client_id: CLI_CLIENT_ID,
    });
    if (poll.status === 200 && typeof poll.body.access_token === 'string') {
      return { key: poll.body.access_token, email: typeof poll.body.account_email === 'string' ? poll.body.account_email : null };
    }
    switch (poll.body.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval += 5000;
        continue;
      case 'access_denied':
        throw new DeviceLoginError('Sign-in was cancelled in the browser. Nothing was saved.');
      case 'expired_token':
        throw new DeviceLoginError('The sign-in code expired. Run login again.');
      default:
        if (poll.status >= 500) continue;
        throw new DeviceLoginError(
          typeof poll.body.error_description === 'string' ? poll.body.error_description : `Sign-in failed (HTTP ${poll.status}).`,
        );
    }
  }
  throw new DeviceLoginError('The sign-in code expired. Run login again.');
}
