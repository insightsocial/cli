import { spawn } from 'node:child_process';

import { isRecord } from './api.js';

/**
 * Local shaping. Every paid call is saved in full first; these only trim what
 * is shown, so re-slicing a result never costs another request.
 */
export interface ShapeOptions {
  jq?: string;
  fields?: string[];
  maxItems?: number;
  summary?: boolean;
}

export class JqError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JqError';
  }
}

export async function shape(value: unknown, options: ShapeOptions): Promise<unknown> {
  if (options.summary) return summarize(value);
  let out = value;
  if (options.jq) out = await evalJq(out, options.jq);
  if (options.fields?.length) out = applyToItems(out, (items) => pickAll(items, options.fields!));
  if (options.maxItems !== undefined) out = capItems(out, options.maxItems);
  return out;
}

/**
 * Where the rows are. Our list endpoints put them at `data.items`; some return
 * `data` as an array; a bare array (e.g. a jq result) is its own list.
 */
function applyToItems(value: unknown, fn: (items: unknown[]) => unknown[]): unknown {
  if (Array.isArray(value)) return fn(value);
  if (!isRecord(value)) return value;
  if (Array.isArray(value.items)) return { ...value, items: fn(value.items) };
  if (isRecord(value.data)) {
    const data = value.data;
    if (Array.isArray(data.items)) return { ...value, data: { ...data, items: fn(data.items) } };
    return value;
  }
  if (Array.isArray(value.data)) return { ...value, data: fn(value.data) };
  return value;
}

export function capItems(value: unknown, max: number): unknown {
  return applyToItems(value, (items) => {
    if (items.length <= max) return items;
    return [...items.slice(0, max), { _truncated: `${items.length - max} more item(s) not shown` }];
  });
}

/**
 * `--fields` over every item. If no field matched anything, say which keys the
 * items do have: a page of `{}` teaches nothing.
 */
function pickAll(items: unknown[], fields: string[]): unknown[] {
  const picked = items.map((item) => pickFields(item, fields));
  const matchedAny = picked.some((p, i) => !isRecord(items[i]) || (isRecord(p) && Object.keys(p).length > 0));
  if (matchedAny || items.length === 0) return picked;
  const keys = isRecord(items[0]) ? Object.keys(items[0]) : [];
  return [{ _note: `None of ${fields.join(', ')} exist on these items. Top-level item keys: ${keys.join(', ')}. Use --summary to see nested keys.` }];
}

/** Keep only the named keys; `a.b.c` descends. */
export function pickFields(item: unknown, fields: string[]): unknown {
  if (!isRecord(item)) return item;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const parts = field.split('.').filter(Boolean);
    let source: unknown = item;
    for (const part of parts) source = isRecord(source) ? source[part] : undefined;
    if (source === undefined) continue;
    let target = out;
    for (const part of parts.slice(0, -1)) {
      if (!isRecord(target[part])) target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]!] = source;
  }
  return out;
}

/**
 * The structure with sizes instead of values, so a reader learns what is large
 * before deciding what to pull. Arrays are described by their first element.
 */
const MAX_DEPTH = 7;

export function summarize(value: unknown, depth = 0): unknown {
  const size = bytes(value);
  if (Array.isArray(value)) {
    const first = value[0];
    return {
      _type: `array[${value.length}]`,
      _bytes: size,
      ...(value.length > 0 && depth < MAX_DEPTH ? { _item: summarize(first, depth + 1) } : {}),
    };
  }
  if (isRecord(value)) {
    if (depth >= MAX_DEPTH) return { _type: 'object', _bytes: size, _keys: Object.keys(value) };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = summarize(v, depth + 1);
    return out;
  }
  if (typeof value === 'string') return value.length > 60 ? `string(${value.length})` : value;
  return value;
}

function bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '');
  } catch {
    return 0;
  }
}

/* ---------------------------------------------------------------- jq -- */

type JqJson = (input: unknown, query: string, flags?: string[]) => Promise<unknown[]>;

/** jq can emit zero, one or many values; one is the common case, so unwrap it. */
function collapse(outputs: unknown[]): unknown {
  return outputs.length === 0 ? null : outputs.length === 1 ? outputs[0] : outputs;
}
let engine: JqJson | null | undefined;

async function loadEngine(): Promise<JqJson | null> {
  if (engine !== undefined) return engine;
  try {
    const mod = (await import('jq-wasm')) as { json: JqJson };
    engine = mod.json;
  } catch {
    engine = null;
  }
  return engine;
}

/**
 * Real jq, bundled as WebAssembly so nothing needs installing; falls back to a
 * system `jq` only if the bundled one cannot load.
 */
export async function evalJq(input: unknown, expr: string): Promise<unknown> {
  const wasm = await loadEngine();
  if (wasm) {
    try {
      return collapse(await wasm(input, expr));
    } catch (error) {
      if (isRecord(error) && error.name === 'JqError') {
        const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
        throw new JqError(stderr || String(error.message ?? 'jq failed'));
      }
    }
  }
  return systemJq(input, expr);
}

function systemJq(input: unknown, expr: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('jq', ['-c', expr], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', () => reject(new JqError('jq is unavailable: reinstall insightsocial or install the jq binary.')));
    child.on('close', (code) => {
      if (code !== 0) return reject(new JqError(err.trim() || `jq exited with code ${code}`));
      const outputs = out
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as unknown);
      resolve(collapse(outputs));
    });
    child.stdin.end(JSON.stringify(input ?? null));
  });
}
