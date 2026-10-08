import { describe, expect, it } from 'vitest';

import { normalizePath } from '../src/api.js';
import { findEndpoint, nextPageParams, normalizeParams, requiredParams, searchEndpoints, suggestPaths, validateParams } from '../src/catalogue.js';
import { CATALOGUE } from './fixtures.js';

const get = (path: string) => findEndpoint(CATALOGUE, path)!;

describe('normalizePath', () => {
  it.each([
    ['instagram/profile', '/v1/instagram/profile'],
    ['/instagram/profile/', '/v1/instagram/profile'],
    ['/v1/instagram/profile', '/v1/instagram/profile'],
    ['https://api.insightsocial.app/v1/instagram/profile?handle=x', '/v1/instagram/profile'],
  ])('%s', (input, expected) => expect(normalizePath(input)).toBe(expected));
});

describe('findEndpoint', () => {
  it('resolves platform aliases', () => {
    expect(findEndpoint(CATALOGUE, 'ig/profile')?.path).toBe('/v1/instagram/profile');
    expect(findEndpoint(CATALOGUE, 'tt/post/comments')?.path).toBe('/v1/tiktok/post/comments');
  });
  it('returns undefined for unknown paths, with suggestions', () => {
    expect(findEndpoint(CATALOGUE, '/v1/instagram/nope')).toBeUndefined();
    expect(suggestPaths(CATALOGUE, '/v1/instagram/profile/post')).toContain('/v1/instagram/profile/posts');
  });
});

describe('searchEndpoints', () => {
  it('reads a platform word as a filter', () => {
    const hits = searchEndpoints(CATALOGUE, 'instagram followers');
    expect(hits[0]?.endpoint.path).toBe('/v1/instagram/followers');
    expect(hits.every((h) => h.endpoint.platform === 'instagram')).toBe(true);
  });
  it('maps synonyms and aliases', () => {
    expect(searchEndpoints(CATALOGUE, 'tt comment')[0]?.endpoint.path).toBe('/v1/tiktok/post/comments');
    expect(searchEndpoints(CATALOGUE, 'ig email')[0]?.endpoint.path).toBe('/v1/instagram/profile');
  });
  it('reads two-word platform names as one platform', () => {
    const shop = { ...CATALOGUE.endpoints[0]!, path: '/v1/tiktokshop/products', platform: 'tiktokshop', label: 'Products', group: 'Products', description: 'Products in a TikTok Shop.' };
    const catalogue = { ...CATALOGUE, endpoints: [...CATALOGUE.endpoints, shop] };
    const hits = searchEndpoints(catalogue, 'tiktok shop products');
    expect(hits[0]?.endpoint.path).toBe('/v1/tiktokshop/products');
    expect(hits.every((h) => h.endpoint.platform === 'tiktokshop')).toBe(true);
  });
  it('lists a platform when there are no other words', () => {
    expect(searchEndpoints(CATALOGUE, '', { platform: 'linkedin' }).map((h) => h.endpoint.path)).toEqual(['/v1/linkedin/search/companies']);
  });
});

describe('validateParams', () => {
  it('accepts valid input', () => {
    expect(validateParams(get('/v1/instagram/profile'), { handle: 'natgeo' })).toEqual([]);
  });
  it('reports missing, unknown and out-of-enum inputs', () => {
    const problems = validateParams(get('/v1/instagram/profile'), { handel: 'x', contact_email: '2' });
    expect(problems).toEqual([
      'missing required "handle"',
      'unknown parameter "handel" (accepts: handle, contact_email)',
      '"contact_email" must be one of 1',
    ]);
  });
  it('treats a one-of group as one required input', () => {
    const followers = get('/v1/instagram/followers');
    expect(validateParams(followers, {})).toEqual(['one of "handle" or "user_id" is required']);
    expect(validateParams(followers, { user_id: '1' })).toEqual([]);
    expect(requiredParams(followers)).toEqual(['handle|user_id']);
  });
  it('lets every paginated endpoint take cursor', () => {
    expect(validateParams(get('/v1/instagram/profile/posts'), { handle: 'x', cursor: 'v2c.abc' })).toEqual([]);
    expect(validateParams(get('/v1/instagram/profile'), { handle: 'x', cursor: 'v2c.abc' })).toHaveLength(1);
  });
});

describe('dry_run and flags', () => {
  it('sends a true flag as the catalogue\'s "1" and drops a false one', () => {
    const posts = get('/v1/instagram/profile/posts');
    expect(normalizeParams(posts, { handle: 'x', dry_run: true })).toEqual({ handle: 'x', dry_run: '1' });
    expect(normalizeParams(posts, { handle: 'x', dry_run: 'TRUE' })).toEqual({ handle: 'x', dry_run: '1' });
    expect(normalizeParams(posts, { handle: 'x', dry_run: 'false' })).toEqual({ handle: 'x' });
    expect(normalizeParams(get('/v1/instagram/profile'), { handle: 'x', contact_email: 'yes' })).toEqual({ handle: 'x', contact_email: '1' });
    expect(validateParams(posts, normalizeParams(posts, { handle: 'x', dry_run: 'true' }))).toEqual([]);
  });
  it('accepts dry_run on endpoints that do not list it, since the API answers it everywhere', () => {
    const profile = get('/v1/instagram/profile');
    expect(validateParams(profile, normalizeParams(profile, { handle: 'x', dry_run: 1 }))).toEqual([]);
    expect(validateParams(profile, { handle: 'x', dry_run: 'maybe' })).toEqual(['"dry_run" must be 1 or true']);
  });
  it('leaves other values alone', () => {
    expect(normalizeParams(get('/v1/instagram/profile'), { handle: 'true' })).toEqual({ handle: 'true' });
  });
});

describe('nextPageParams', () => {
  it('sends next_cursor back as cursor, whatever the native input is called', () => {
    const next = nextPageParams(get('/v1/instagram/profile/posts'), { handle: 'x' }, { next_cursor: 'v2c.abc', has_more: true });
    expect(next).toEqual({ handle: 'x', cursor: 'v2c.abc' });
  });
  it('increments page when there is no cursor', () => {
    const next = nextPageParams(get('/v1/linkedin/search/companies'), { query: 'a', page: '2' }, { has_more: true });
    expect(next).toEqual({ query: 'a', page: '3' });
  });
  it('is undefined on the last page', () => {
    expect(nextPageParams(get('/v1/instagram/profile/posts'), {}, { next_cursor: 'v2c.abc', has_more: false })).toBeUndefined();
  });
});
