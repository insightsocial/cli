import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { API_KEY_ENV, BASE_URL_ENV, DEFAULT_BASE_URL, HOME_ENV } from './constants.js';

export interface StoredConfig {
  apiKey?: string;
  baseUrl?: string;
}

export type KeySource = 'flag' | 'env' | 'config';

export interface ResolvedKey {
  key: string;
  source: KeySource;
}

/** `~/.insightsocial`, or `$INSIGHTSOCIAL_HOME` (tests point it at a temp dir). */
export function configHome(env: NodeJS.ProcessEnv = process.env): string {
  return env[HOME_ENV]?.trim() || join(homedir(), '.insightsocial');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configHome(env), 'config.json');
}

export async function readStoredConfig(env: NodeJS.ProcessEnv = process.env): Promise<StoredConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath(env), 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as StoredConfig) : {};
  } catch {
    return {};
  }
}

export async function writeStoredConfig(next: StoredConfig, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = configHome(env);
  await mkdir(dir, { recursive: true });
  const path = configPath(env);
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // writeFile's mode only applies on create; tighten an existing file too.
  await chmod(path, 0o600);
  return path;
}

export async function clearStoredKey(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const current = await readStoredConfig(env);
  delete current.apiKey;
  if (Object.keys(current).length === 0) {
    await rm(configPath(env), { force: true });
    return;
  }
  await writeStoredConfig(current, env);
}

/**
 * Resolution order: `--api-key`, then `$INSIGHTSOCIAL_API_KEY`, then the saved
 * config. The saved config is what lets an MCP client launch `insightsocial mcp`
 * with no env block at all after one `insightsocial login`.
 */
export async function resolveKey(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedKey | undefined> {
  if (flag?.trim()) return { key: flag.trim(), source: 'flag' };
  const fromEnv = env[API_KEY_ENV]?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const stored = (await readStoredConfig(env)).apiKey?.trim();
  if (stored) return { key: stored, source: 'config' };
  return undefined;
}

export async function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const raw = env[BASE_URL_ENV]?.trim() || (await readStoredConfig(env)).baseUrl?.trim() || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '');
}

/** Keys are `isk_live_` + 43 base64url characters, so `-` and `_` belong in them (most keys have one). */
export function looksLikeKey(value: string): boolean {
  return /^isk_(live|test)_[A-Za-z0-9_-]{16,}$/.test(value.trim());
}

/** `isk_live_••••cJnA` — never print a whole key. */
export function maskKey(key: string): string {
  const prefix = key.match(/^isk_(live|test)_/)?.[0] ?? '';
  return `${prefix}••••${key.slice(-4)}`;
}
