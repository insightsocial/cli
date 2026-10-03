import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import type { CallEnvelope } from './api.js';
import { configHome } from './config.js';

/**
 * What lands on disk: the response envelope exactly as the API sent it, plus
 * the request that produced it, so the next page can be asked for without
 * reconstructing anything.
 */
export interface SavedResult extends CallEnvelope {
  request: { path: string; params: Record<string, unknown>; saved_at: string };
}

/** The CLI saves next to the work (`./.insightsocial`); the MCP server, whose cwd is arbitrary, under the home dir. */
export function cliResultsDir(cwd = process.cwd()): string {
  return join(cwd, '.insightsocial');
}

export function mcpResultsDir(): string {
  return join(configHome(), 'results');
}

/** `instagram-profile-posts-20261003T012233Z-a1b2` */
export function resultId(path: string, now = new Date()): string {
  const slug = path
    .replace(/^\/?v1\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const rand = Math.random().toString(16).slice(2, 6);
  return `${slug}-${stamp}-${rand}`;
}

export async function saveResult(
  dir: string,
  envelope: CallEnvelope,
  request: { path: string; params: Record<string, unknown> },
  outFile?: string,
): Promise<{ id: string; file: string }> {
  const saved: SavedResult = { ...envelope, request: { ...request, saved_at: new Date().toISOString() } };
  const file = outFile ? resolve(outFile) : join(dir, `${resultId(request.path)}.json`);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
  return { id: basename(file, '.json'), file };
}

export async function loadResult(file: string): Promise<SavedResult> {
  return JSON.parse(await readFile(file, 'utf8')) as SavedResult;
}

/**
 * A result id, or (CLI only) a path, to a file. The MCP server passes
 * `allowPaths: false`: a model must not be able to read arbitrary files on the
 * user's disk through `read_result`.
 */
export function resultFile(dir: string, idOrPath: string, options: { allowPaths?: boolean } = {}): string {
  if (options.allowPaths !== false && (idOrPath.endsWith('.json') || idOrPath.includes('/'))) return resolve(idOrPath);
  if (!/^[a-z0-9-]+$/i.test(idOrPath)) throw new Error(`Not a result id: ${idOrPath}`);
  return join(dir, `${idOrPath}.json`);
}

/** Newest saved result, optionally only for one endpoint (`instagram/profile`). */
export async function latestResult(dir: string, endpoint?: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json') && n !== 'catalogue.json' && n !== 'config.json');
  } catch {
    return undefined;
  }
  const prefix = endpoint ? `${endpoint.replace(/^\/?v1\//, '').replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-` : '';
  // Endpoint slugs nest (`instagram-profile` is a prefix of `instagram-profile-posts`), so a
  // filtered match must be followed directly by the timestamp.
  const matches = names.filter((n) => !prefix || (n.startsWith(prefix) && /^\d{8}T/.test(n.slice(prefix.length))));
  let best: { file: string; mtime: number } | undefined;
  for (const name of matches) {
    const file = join(dir, name);
    const mtime = (await stat(file)).mtimeMs;
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best?.file;
}

export function itemCount(envelope: { data?: unknown }): number | undefined {
  const data = envelope.data as { items?: unknown } | unknown[] | undefined;
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) {
    return ((data as { items: unknown[] }).items).length;
  }
  return undefined;
}
