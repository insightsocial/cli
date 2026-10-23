import type { Catalogue, Endpoint } from '../src/api.js';

function endpoint(partial: Partial<Endpoint> & Pick<Endpoint, 'path'>): Endpoint {
  const platform = partial.path.split('/')[2]!;
  return {
    method: 'GET',
    platform,
    group: 'Profile',
    label: 'Profile',
    description: 'Returns a thing. Use it when needed.',
    credits: 20,
    paginates: false,
    params: [],
    available: true,
    ...partial,
  };
}

export const CATALOGUE: Catalogue = {
  base_url: 'https://api.test/v1',
  endpoints: [
    endpoint({
      path: '/v1/youtube/channel',
      group: 'Channel',
      label: 'Channel',
      description: "Returns a YouTube channel's public profile: bio, subscriber count and public email.",
      params: [
        { name: 'handle', required: true, type: 'string', example: 'natgeo' },
        { name: 'contact_email', required: false, type: 'string', enum: ['1'] },
      ],
    }),
    endpoint({
      path: '/v1/tiktok/profile/videos',
      group: 'Profile',
      label: 'Profile/Videos',
      description: "Returns a user's recent videos with caption and like counts.",
      credits: { min: 20, max: 340 },
      paginates: true,
      params: [
        { name: 'handle', required: true, type: 'string' },
        { name: 'max_cursor', required: false, type: 'string' },
        { name: 'dry_run', required: false, type: 'string', enum: ['1'] },
      ],
    }),
    endpoint({
      path: '/v1/tiktok/user/followers',
      group: 'Followers',
      label: 'Followers',
      description: "Returns an account's followers.",
      credits: { min: 100, max: 200 },
      paginates: true,
      params: [
        { name: 'handle', required: false, type: 'string', one_of_group: 'handle|user_id' },
        { name: 'user_id', required: false, type: 'string', one_of_group: 'handle|user_id' },
      ],
    }),
    endpoint({
      path: '/v1/tiktok/post/comments',
      group: 'Post',
      label: 'Post/Comments',
      description: 'Returns comments on a TikTok video.',
      paginates: true,
      params: [{ name: 'url', required: true, type: 'string' }],
    }),
    endpoint({
      path: '/v1/linkedin/search/companies',
      group: 'Search',
      label: 'Search/Companies',
      description: 'Searches companies.',
      paginates: true,
      params: [
        { name: 'query', required: true, type: 'string' },
        { name: 'page', required: false, type: 'integer' },
      ],
    }),
    endpoint({ path: '/v1/youtube/videos', method: 'POST', available: false, description: 'Batch videos.' }),
  ],
};

export function postsEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    platform: 'tiktok',
    endpoint: '/v1/tiktok/profile/videos',
    schema_version: '2',
    data: {
      items: Array.from({ length: 12 }, (_, i) => ({
        post: {
          id: `p${i}`,
          url: `https://www.tiktok.com/@natgeo/video/${i}`,
          kind: 'short',
          author: { id: null, username: 'natgeo' },
          engagement: { views: null, likes: i * 10, comments: i },
          language: null,
        },
      })),
    },
    pagination: { next_cursor: 'v2c.abc', has_more: true, page_size: 12 },
    unavailable: ['items[].post.engagement.views'],
    credits_used: 20,
    credits_remaining: 980,
    request_id: 'req_000000000001',
    ...overrides,
  };
}

/** A fetch that answers from a route table and records every request. */
export function fakeFetch(routes: Record<string, (url: URL, init?: RequestInit) => { status?: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const handler = routes[url.pathname];
    if (!handler) return new Response(JSON.stringify({ success: false, error: { type: 'UNKNOWN_ENDPOINT', message: 'No such endpoint.' } }), { status: 404 });
    const { status = 200, body, headers } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  return { impl, calls };
}
