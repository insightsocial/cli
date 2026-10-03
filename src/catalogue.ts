import { formatCredits, normalizePath, type Catalogue, type Endpoint } from './api.js';
import { PLATFORMS } from './constants.js';

/** Words people use for a platform that are not its id. */
const PLATFORM_ALIASES: Record<string, string> = {
  ig: 'instagram',
  insta: 'instagram',
  tt: 'tiktok',
  x: 'twitter',
  tweet: 'twitter',
  tweets: 'twitter',
  fb: 'facebook',
  li: 'linkedin',
  yt: 'youtube',
  pin: 'pinterest',
  pins: 'pinterest',
  subreddit: 'reddit',
};

/** Synonyms that map a user's word onto the words our paths use. */
const WORD_ALIASES: Record<string, string[]> = {
  user: ['profile'],
  account: ['profile'],
  bio: ['profile'],
  email: ['profile', 'contact'],
  contact: ['profile'],
  video: ['videos', 'post', 'media'],
  videos: ['video', 'posts'],
  reel: ['reels'],
  posts: ['post'],
  comment: ['comments'],
  follower: ['followers'],
  likes: ['likers', 'reactions'],
  reactions: ['reactors'],
  company: ['company', 'page'],
  job: ['jobs'],
  transcript: ['transcript', 'transcripts'],
  hashtag: ['hashtag', 'tag'],
};

export interface SearchOptions {
  platform?: string;
  limit?: number;
}

export interface SearchHit {
  endpoint: Endpoint;
  score: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

export function resolvePlatform(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if ((PLATFORMS as readonly string[]).includes(v)) return v;
  return PLATFORM_ALIASES[v];
}

/**
 * Keyword search over the catalogue. Deliberately simple and local: 239
 * endpoints fit in memory, and a ranking anyone can predict beats a clever one
 * an agent cannot reason about. Path words weigh most, then the label, then the
 * description.
 */
export function searchEndpoints(catalogue: Catalogue, query: string, options: SearchOptions = {}): SearchHit[] {
  let platform = resolvePlatform(options.platform);
  const words: string[] = [];
  for (const token of tokenize(query)) {
    const asPlatform = resolvePlatform(token);
    if (asPlatform && !platform) {
      platform = asPlatform;
      continue;
    }
    if (asPlatform) continue;
    words.push(token, ...(WORD_ALIASES[token] ?? []));
  }

  const pool = catalogue.endpoints.filter((e) => !platform || e.platform === platform);
  const limit = options.limit ?? 10;

  if (words.length === 0) {
    return pool.slice(0, limit).map((endpoint) => ({ endpoint, score: 0 }));
  }

  const hits: SearchHit[] = [];
  for (const endpoint of pool) {
    const pathWords = new Set(tokenize(endpoint.path.replace(/^\/v1\/[^/]+/, '')));
    const labelWords = new Set(tokenize(`${endpoint.label} ${endpoint.group}`));
    const descWords = new Set(tokenize(endpoint.description));
    let score = 0;
    for (const word of new Set(words)) {
      if (pathWords.has(word)) score += 3;
      if (labelWords.has(word)) score += 2;
      if (descWords.has(word)) score += 1;
    }
    if (score === 0) continue;
    // Shorter paths are the general-purpose endpoints; prefer them on a tie.
    score -= endpoint.path.split('/').length * 0.01;
    if (!endpoint.available) score -= 0.5;
    hits.push({ endpoint, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function findEndpoint(catalogue: Catalogue, path: string): Endpoint | undefined {
  const [, v1, platform, ...rest] = normalizePath(path).split('/');
  // `ig/profile` and `x/user/tweets` mean what they look like.
  const wanted = `/${v1}/${resolvePlatform(platform) ?? platform}/${rest.join('/')}`;
  return catalogue.endpoints.find((e) => e.path === wanted);
}

/** Closest paths for a typo, so "not found" always comes with somewhere to go. */
export function suggestPaths(catalogue: Catalogue, path: string, limit = 3): string[] {
  const wanted = normalizePath(path);
  const platform = wanted.split('/')[2];
  const words = wanted.split('/').slice(3).join(' ');
  return searchEndpoints(catalogue, words, { platform, limit }).map((h) => h.endpoint.path);
}

/** Required inputs; a one-of group reads as "url|pageId". */
export function requiredParams(endpoint: Endpoint): string[] {
  const out = endpoint.params.filter((p) => p.required && !p.one_of_group).map((p) => p.name);
  const groups = new Set(endpoint.params.map((p) => p.one_of_group).filter((g): g is string => Boolean(g)));
  return [...out, ...groups];
}

/** One line per endpoint, for `search`/`list` and the MCP search tool. */
export function summarizeEndpoint(endpoint: Endpoint): Record<string, unknown> {
  return {
    path: endpoint.path,
    label: endpoint.label,
    credits: endpoint.credits,
    required: requiredParams(endpoint),
    paginates: endpoint.paginates,
    ...(endpoint.available ? {} : { available: false }),
    description: firstSentence(endpoint.description),
  };
}

export function firstSentence(text: string): string {
  const first = text.split('\n')[0] ?? '';
  const match = first.match(/^.*?[.!?](\s|$)/);
  return (match ? match[0] : first).trim();
}

/** The full contract for one endpoint, shaped for a reader rather than a form. */
export function describeEndpoint(endpoint: Endpoint): Record<string, unknown> {
  return {
    path: endpoint.path,
    method: endpoint.method,
    platform: endpoint.platform,
    label: endpoint.label,
    description: endpoint.description,
    credits: endpoint.credits,
    metered: typeof endpoint.credits !== 'number',
    paginates: endpoint.paginates,
    available: endpoint.available,
    params: endpoint.params.map((p) => ({
      name: p.name,
      required: p.required,
      type: p.type,
      ...(p.enum ? { enum: p.enum } : {}),
      ...(p.minimum !== undefined ? { minimum: p.minimum } : {}),
      ...(p.maximum !== undefined ? { maximum: p.maximum } : {}),
      ...(p.example !== undefined ? { example: p.example } : {}),
      ...(p.one_of_group ? { one_of_group: p.one_of_group } : {}),
      help: p.help ?? p.description,
    })),
  };
}

export function endpointLine(endpoint: Endpoint): string {
  const req = requiredParams(endpoint);
  const price = `${formatCredits(endpoint.credits)} cr`;
  const flags = [endpoint.paginates ? 'paginates' : '', endpoint.available ? '' : 'not available yet'].filter(Boolean);
  return `${endpoint.path.padEnd(44)} ${price.padStart(12)}  ${req.length ? `needs ${req.join(', ')}` : ''}${flags.length ? `  [${flags.join(', ')}]` : ''}`;
}

/**
 * Check inputs locally before spending a request: unknown names, missing
 * required params and enum values. The server checks again; this only saves a
 * round trip and gives a better message.
 */
export function validateParams(endpoint: Endpoint, params: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const known = new Map(endpoint.params.map((p) => [p.name, p]));
  const groups = new Map<string, string[]>();
  for (const p of endpoint.params) {
    if (p.one_of_group) groups.set(p.one_of_group, [...(groups.get(p.one_of_group) ?? []), p.name]);
  }
  for (const p of endpoint.params) {
    if (!p.required) continue;
    if (p.one_of_group) continue;
    if (params[p.name] === undefined || params[p.name] === '') problems.push(`missing required "${p.name}"`);
  }
  // A one-of group ("url|pageId") marks each member optional, but the endpoint
  // needs one of them: that is what the group means.
  for (const names of groups.values()) {
    if (!names.some((n) => params[n] !== undefined && params[n] !== '')) {
      problems.push(`one of ${names.map((n) => `"${n}"`).join(' or ')} is required`);
    }
  }
  for (const [name, value] of Object.entries(params)) {
    const spec = known.get(name);
    // Every paginated endpoint takes `cursor`, listed or not (see nextPageParams).
    if (!spec && name === 'cursor' && endpoint.paginates) continue;
    if (!spec) {
      problems.push(`unknown parameter "${name}" (accepts: ${[...known.keys()].join(', ') || 'none'})`);
      continue;
    }
    if (spec.enum && value !== undefined && !spec.enum.includes(String(value))) {
      problems.push(`"${name}" must be one of ${spec.enum.join(', ')}`);
    }
  }
  return problems;
}

/**
 * The inputs for the next page, or undefined when there is none.
 *
 * `next_cursor` always goes back as `cursor`, whatever the endpoint calls its
 * own paging input (`next_max_id`, `continuationToken`, …): the cursor we hand
 * out records which input it belongs to, and only `cursor` is decoded. Sent
 * under the native name it is passed through undecoded and page 1 comes back.
 */
export function nextPageParams(
  endpoint: Endpoint,
  params: Record<string, unknown>,
  pagination: { next_cursor?: string | null; has_more?: boolean } | undefined,
): Record<string, unknown> | undefined {
  if (!pagination?.has_more) return undefined;
  if (pagination.next_cursor) return { ...params, cursor: pagination.next_cursor };
  if (endpoint.params.some((p) => p.name === 'page')) {
    const current = Number(params.page ?? 1);
    return { ...params, page: String((Number.isFinite(current) ? current : 1) + 1) };
  }
  return undefined;
}
