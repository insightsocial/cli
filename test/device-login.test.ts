import { describe, expect, it, vi } from 'vitest';

import { deviceLogin, DeviceLoginError } from '../src/device-login.js';

/** A fake API answering device_authorization once and then the given token polls in order. */
function fakeApi(polls: { status: number; body: Record<string, unknown> }[]) {
  const calls: { url: string; form: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    calls.push({ url: String(url), form });
    if (String(url).endsWith('/oauth/device_authorization')) {
      return Response.json({
        device_code: 'dev-123',
        user_code: 'BCDF-GHJK',
        verification_uri: 'https://www.insightsocial.app/connect/device',
        expires_in: 900,
        interval: 5,
      });
    }
    const next = polls.shift()!;
    return Response.json(next.body, { status: next.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const base = { baseUrl: 'https://api.insightsocial.app', sleep: async () => {}, deviceName: 'test-mac' };

describe('deviceLogin', () => {
  it('prints the link and code, opens the browser, and waits for Allow', async () => {
    const { fetchImpl, calls } = fakeApi([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'slow_down' } },
      { status: 200, body: { access_token: 'isk_live_abc', token_type: 'Bearer', account_email: 'me@example.com' } },
    ]);
    const lines: string[] = [];
    const opened: string[] = [];
    const key = await deviceLogin({ ...base, fetchImpl, log: (l) => lines.push(l), open: (u) => opened.push(u) });

    expect(key).toEqual({ key: 'isk_live_abc', email: 'me@example.com' });
    expect(calls[0]!.form).toEqual({ client_id: 'insightsocial-cli', device_name: 'test-mac' });
    expect(calls.slice(1).every((c) => c.form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code' && c.form.device_code === 'dev-123')).toBe(true);
    expect(opened).toEqual(['https://www.insightsocial.app/connect/device']);
    expect(lines.join('\n')).toContain('BCDF-GHJK');
  });

  it('does not open a browser when asked not to', async () => {
    const { fetchImpl } = fakeApi([{ status: 200, body: { access_token: 'isk_live_abc' } }]);
    const open = vi.fn();
    await deviceLogin({ ...base, fetchImpl, log: () => {}, open, openBrowser: false });
    expect(open).not.toHaveBeenCalled();
  });

  it('stops with a plain message when the user cancels or the code expires', async () => {
    for (const [error, text] of [['access_denied', /cancelled/], ['expired_token', /expired/]] as const) {
      const { fetchImpl } = fakeApi([{ status: 400, body: { error } }]);
      await expect(deviceLogin({ ...base, fetchImpl, log: () => {}, open: () => {} })).rejects.toThrow(text);
    }
  });

  it('says why when sign-in cannot start', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: 'temporarily_unavailable', error_description: 'Retry shortly.' }, { status: 503 })) as unknown as typeof fetch;
    await expect(deviceLogin({ ...base, fetchImpl, log: () => {} })).rejects.toBeInstanceOf(DeviceLoginError);
  });
});

describe('safeToOpen', () => {
  it('opens only https on our domain or the configured host, or http on localhost', async () => {
    const { safeToOpen } = await import('../src/device-login.js');
    const base = 'https://api.insightsocial.app';
    expect(safeToOpen('https://www.insightsocial.app/connect/device', base)).toBe(true);
    expect(safeToOpen('http://localhost:3000/connect/device', 'http://localhost:3200')).toBe(true);
    expect(safeToOpen('https://api.example.dev/device', 'https://api.example.dev')).toBe(true);
    expect(safeToOpen('https://evil.example/device', base)).toBe(false);
    expect(safeToOpen('https://www.insightsocial.app.evil.example/x', base)).toBe(false);
    expect(safeToOpen('file:///etc/passwd', base)).toBe(false);
    expect(safeToOpen('http://www.insightsocial.app/connect/device', base)).toBe(false);
    expect(safeToOpen('https://x&calc.exe@www.insightsocial.app/', base)).toBe(false);
  });
});
