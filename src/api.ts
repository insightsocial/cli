import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { configHome } from './config.js';
import {
  BILLING_URL,
  CATALOGUE_TTL_MS,
  CLIENT_HEADER,
  KEYS_URL,
  SCHEMA_VERSION,
  SCHEMA_VERSION_HEADER,
  VERSION,
} from './constants.js';

/* ------------------------------------------------------------- types -- */

export type Credits = number | { min: number; max: number };

export interface EndpointParam {
  name: string;
  required: boolean;
  in?: string;
  type?: string;
  description?: string;
  help?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  example?: unknown;
  one_of_group?: string;
}

export interface Endpoint {
  path: string;
  method: string;
  platform: string;
  group: string;
  label: string;
  description: string;
  credits: Credits;
  tier?: string;
  paginates: boolean;
  cache_ttl_seconds?: number;
  params: EndpointParam[];
  available: boolean;
}

export interface Catalogue {
  base_url: string;
  docs?: string;
  summary?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  endpoints: Endpoint[];
}

/** The success envelope every paid /v1 call returns (schema 2). */
export interface CallEnvelope {
  success: true;
  platform: string;
  endpoint: string;
  /** "2" on every schema-2 body; absent on a legacy one. */
  schema_version?: string;
  data: unknown;
  pagination?: { next_cursor?: string | null; has_more?: boolean; page_size?: number } & Record<string, unknown>;
  /** Paths into `data` this platform normally fills and this response could not, e.g. `items[].post.author.id`. */
  unavailable?: string[];
  credits_used: number;
  credits_remaining: number;
  request_id: string;
  cached?: boolean;
  idempotent_replay?: boolean;
  /** Why this was or was not charged: "miss", "shared_cache", "replay", "no_result" or "dry_run". */
  charge_reason?: string;
  /** One of the account's 10 lifetime free calls covered this call's charge. */
  free_call?: boolean;
  [key: string]: unknown;
}

/**
 * Any non-2xx answer. `type` and `message` come from our own error envelope,
 * which is written for callers, so they are safe to print verbatim.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly requestId?: string,
    readonly retryAfterSeconds?: number,
    /** The query parameter at fault (`error.param`), when the API names one. */
    readonly param?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** One extra line telling a person or an agent what to do next. */
  get hint(): string | undefined {
    if (this.status === 401) return `Set a valid key: insightsocial login (keys: ${KEYS_URL})`;
    if (this.status === 402) return `Not enough credits. Top up at ${BILLING_URL}`;
    if (this.status === 429) {
      return this.retryAfterSeconds ? `Rate limited. Retry in ${this.retryAfterSeconds}s.` : 'Rate limited. Retry shortly.';
    }
    if (this.type === 'UNKNOWN_ENDPOINT') return 'Find the right path with: insightsocial search <words>';
    if (this.type === 'INVALID_REQUEST') return 'Check the inputs with: insightsocial describe <path>';
    if (this.type === 'UNSUPPORTED_PARAMETER') {
      return `Remove ${this.param ? `"${this.param}"` : 'that parameter'} and retry; it asks for analysis schema 2 does not serve. Nothing was charged.`;
    }
    if (this.type === 'CURSOR_INVALID' || this.type === 'CURSOR_EXPIRED') {
      if (this.param && this.param !== 'cursor') return `Send pagination.next_cursor as "cursor", not as "${this.param}".`;
      return 'Restart without cursor, then re-send the same parameters with the new pagination.next_cursor as cursor (cursors last 24 hours).';
    }
    if (this.type === 'UPSTREAM_INVALID') return 'The data source answered with something unreadable. Nothing was charged; retry shortly with the same idempotency key.';
    if (this.type === 'IDEMPOTENCY_KEY_REUSED') return 'That idempotency key was already used for a different request. Use a new key.';
    if (this.type === 'IDEMPOTENCY_REPLAY_UNAVAILABLE') {
      return 'The original call succeeded but is too large to replay. Use the result you saved; a new key fetches it again and is charged.';
    }
    if (this.type === 'METHOD_NOT_SUPPORTED') return 'This endpoint is not available through the API yet. Pick another with: insightsocial search <words>';
    return undefined;
  }
}

/* ------------------------------------------------------------ client -- */

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  /** Who is calling: "cli" or "mcp". Sent so adoption can be measured per surface. */
  surface: 'cli' | 'mcp';
  fetchImpl?: typeof fetch;
  /** Where the catalogue cache lives. Undefined disables the disk cache. */
  cacheDir?: string;
}

export interface CallOptions {
  idempotencyKey?: string;
  /** Skip every cache and fetch fresh. Always charged. */
  fresh?: boolean;
}

export class InsightSocialClient {
  private readonly fetchImpl: typeof fetch;
  private memoryCatalogue: { at: number; value: Catalogue } | undefined;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get hasKey(): boolean {
    return Boolean(this.options.apiKey);
  }

  private headers(withKey: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': `insightsocial-${this.options.surface}/${VERSION}`,
      [CLIENT_HEADER]: `${this.options.surface}/${VERSION}`,
    };
    if (withKey) {
      if (!this.options.apiKey) {
        throw new ApiError(401, 'MISSING_KEY', 'No API key configured.');
      }
      headers['x-api-key'] = this.options.apiKey;
    }
    return headers;
  }

  private async request(path: string, init: { withKey: boolean; headers?: Record<string, string> }): Promise<unknown> {
    const url = `${this.options.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { ...this.headers(init.withKey), ...init.headers } });
    } catch (error) {
      throw new ApiError(0, 'NETWORK_ERROR', `Could not reach ${this.options.baseUrl}: ${errorMessage(error)}`);
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok || (isRecord(body) && body.success === false)) {
      const err = isRecord(body) && isRecord(body.error) ? body.error : {};
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new ApiError(
        response.status,
        typeof err.type === 'string' ? err.type : `HTTP_${response.status}`,
        typeof err.message === 'string' ? err.message : `Request failed with HTTP ${response.status}.`,
        isRecord(body) && typeof body.request_id === 'string' ? body.request_id : response.headers.get('x-request-id') ?? undefined,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        typeof err.param === 'string' ? err.param : undefined,
      );
    }
    return body;
  }

  /** Public and free. Cached in memory, and on disk for the CLI. */
  async catalogue(options: { refresh?: boolean } = {}): Promise<Catalogue> {
    const now = Date.now();
    if (!options.refresh && this.memoryCatalogue && now - this.memoryCatalogue.at < CATALOGUE_TTL_MS) {
      return this.memoryCatalogue.value;
    }
    const cacheFile = this.options.cacheDir ? join(this.options.cacheDir, 'catalogue.json') : undefined;
    if (!options.refresh && cacheFile) {
      const cached = await readCache(cacheFile, this.options.baseUrl);
      if (cached && now - cached.at < CATALOGUE_TTL_MS) {
        this.memoryCatalogue = cached;
        return cached.value;
      }
    }
    const body = await this.request('/v1/endpoints', { withKey: false });
    if (!isRecord(body) || !Array.isArray(body.endpoints)) {
      throw new ApiError(502, 'BAD_CATALOGUE', 'The endpoint catalogue came back in an unexpected shape.');
    }
    const value = body as unknown as Catalogue;
    this.memoryCatalogue = { at: now, value };
    if (cacheFile) await writeCache(cacheFile, this.options.baseUrl, this.memoryCatalogue);
    return value;
  }

  async credits(): Promise<Record<string, unknown>> {
    const body = await this.request('/v1/credits', { withKey: true });
    return isRecord(body) ? body : {};
  }

  async call(path: string, params: Record<string, unknown>, options: CallOptions = {}): Promise<CallEnvelope> {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      query.set(name, typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    const qs = query.toString();
    // Pin the contract this client is written against, whatever the key's default.
    const headers: Record<string, string> = { [SCHEMA_VERSION_HEADER]: SCHEMA_VERSION };
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    if (options.fresh) headers['Cache-Control'] = 'no-cache';
    const body = await this.request(`${normalizePath(path)}${qs ? `?${qs}` : ''}`, { withKey: true, headers });
    return body as CallEnvelope;
  }
}

/** Accept `instagram/profile`, `/instagram/profile` or `/v1/instagram/profile`. */
export function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/^https?:\/\/[^/]+/, '').split('?')[0]!.replace(/\/+$/, '');
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withSlash.startsWith('/v1/') ? withSlash : `/v1${withSlash}`;
}

export function defaultCacheDir(): string {
  return configHome();
}

async function readCache(file: string, baseUrl: string): Promise<{ at: number; value: Catalogue } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { at?: number; baseUrl?: string; value?: Catalogue };
    if (parsed.baseUrl !== baseUrl || typeof parsed.at !== 'number' || !parsed.value) return undefined;
    return { at: parsed.at, value: parsed.value };
  } catch {
    return undefined;
  }
}

async function writeCache(file: string, baseUrl: string, entry: { at: number; value: Catalogue }): Promise<void> {
  try {
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify({ baseUrl, ...entry }), 'utf8');
  } catch {
    // A read-only home must not break a call; the cache is only a convenience.
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatCredits(credits: Credits): string {
  return typeof credits === 'number' ? `${credits}` : `${credits.min}–${credits.max}`;
}

/**
 * Why a call cost what it did, for the `run` output: `charge_reason`, plus
 * "free call" when one of the account's 10 free calls covered it, e.g.
 * "miss, free call" (credits_used 0) or "shared_cache" (5 credits).
 */
export function chargeLine(envelope: Pick<CallEnvelope, 'charge_reason' | 'free_call'>): string | undefined {
  const parts = [envelope.charge_reason, envelope.free_call ? 'free call' : undefined].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}
