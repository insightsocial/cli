import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { InsightSocialClient } from '../src/api.js';
import { createServer } from '../src/mcp.js';
import { CATALOGUE, fakeFetch, postsEnvelope } from './fixtures.js';

async function connect(apiKey: string | undefined, routes: Parameters<typeof fakeFetch>[0]) {
  const fetch = fakeFetch({ '/v1/endpoints': () => ({ body: { success: true, ...CATALOGUE } }), ...routes });
  const client = new InsightSocialClient({ baseUrl: 'https://api.test', apiKey, surface: 'mcp', fetchImpl: fetch.impl });
  const server = createServer({ client, resultsDir: await mkdtemp(join(tmpdir(), 'is-mcp-')) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { body: JSON.parse(result.content[0]!.text), isError: Boolean(result.isError) };
  };
  return { mcp, call, calls: fetch.calls };
}

describe('MCP server', () => {
  it('lists five tools and sends instructions', async () => {
    const { mcp } = await connect(undefined, {});
    expect((await mcp.listTools()).tools.map((t) => t.name)).toEqual([
      'search_endpoints',
      'describe_endpoint',
      'call_endpoint',
      'read_result',
      'get_credits',
    ]);
    expect(mcp.getInstructions()).toContain('read_result');
  });

  it('searches and describes without a key', async () => {
    const { call } = await connect(undefined, {});
    const search = await call('search_endpoints', { query: 'instagram followers', limit: 2 });
    expect(search.body.endpoints[0]).toMatchObject({ path: '/v1/instagram/followers', required: ['handle|user_id'] });
    const describe = await call('describe_endpoint', { path: 'ig/profile' });
    expect(describe.body.params.map((p: { name: string }) => p.name)).toEqual(['handle', 'contact_email']);
  });

  it('refuses to call without a key, and catches bad inputs before any request', async () => {
    expect((await connect(undefined, {}).then((c) => c.call('call_endpoint', { path: '/v1/instagram/profile', params: { handle: 'x' } }))).isError).toBe(true);
    const { call, calls } = await connect('isk_live_test', {});
    const bad = await call('call_endpoint', { path: '/v1/instagram/profile', params: { handel: 'x' } });
    expect(bad.isError).toBe(true);
    expect(bad.body.next_step).toContain('Nothing was charged');
    expect(calls.filter((c) => c.url.pathname !== '/v1/endpoints')).toHaveLength(0);
  });

  it('calls, saves, trims, and hands back the next page as cursor', async () => {
    const { call, calls } = await connect('isk_live_test', {
      '/v1/instagram/profile/posts': () => ({ body: postsEnvelope() }),
    });
    const res = await call('call_endpoint', { path: '/v1/instagram/profile/posts', params: { handle: 'natgeo' }, fields: ['post.id'], max_items: 2 });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({
      items: 12,
      credits_used: 20,
      credits_remaining: 980,
      schema_version: '2',
      unavailable: ['items[].post.engagement.views'],
    });
    expect(res.body.data.items).toEqual([{ post: { id: 'p0' } }, { post: { id: 'p1' } }, { _truncated: '10 more item(s) not shown' }]);
    expect(res.body.pagination.next_call).toEqual({ path: '/v1/instagram/profile/posts', params: { handle: 'natgeo', cursor: 'v2c.abc' } });

    const sent = calls.find((c) => c.url.pathname === '/v1/instagram/profile/posts')!;
    expect(sent.headers['x-api-key']).toBe('isk_live_test');
    expect(sent.headers['x-insightsocial-client']).toMatch(/^mcp\//);
    expect(sent.headers['InsightSocial-Version']).toBe('2');

    const reread = await call('read_result', { result_id: res.body.result_id, jq: '[.data.items[].post.engagement.likes] | add' });
    expect(reread.body.result).toBe(660);
    expect(calls.filter((c) => c.url.pathname === '/v1/instagram/profile/posts')).toHaveLength(1);
  });

  it('passes API errors through with a next step', async () => {
    const { call } = await connect('isk_live_test', {
      '/v1/instagram/profile': () => ({
        status: 402,
        body: { success: false, error: { type: 'INSUFFICIENT_CREDITS', message: 'Not enough credits.' }, request_id: 'req_1' },
      }),
    });
    const res = await call('call_endpoint', { path: '/v1/instagram/profile', params: { handle: 'x' } });
    expect(res.isError).toBe(true);
    expect(res.body).toMatchObject({ status: 402, type: 'INSUFFICIENT_CREDITS', request_id: 'req_1' });
    expect(res.body.next_step).toContain('billing');
  });

  it('names the refused parameter and how to recover', async () => {
    const { call } = await connect('isk_live_test', {
      '/v1/instagram/profile/posts': () => ({
        status: 400,
        body: {
          success: false,
          error: { type: 'UNSUPPORTED_PARAMETER', message: '`label` is not supported.', param: 'label' },
          request_id: 'req_2',
          credits_used: 0,
          credits_remaining: null,
        },
      }),
    });
    const res = await call('call_endpoint', { path: '/v1/instagram/profile/posts', params: { handle: 'x' } });
    expect(res.isError).toBe(true);
    expect(res.body).toMatchObject({ status: 400, type: 'UNSUPPORTED_PARAMETER', param: 'label', request_id: 'req_2' });
    expect(res.body.next_step).toContain('Remove "label"');
  });

  it('prices a call with dry_run and says so', async () => {
    const { call, calls } = await connect('isk_live_test', {
      '/v1/instagram/profile': () => ({
        body: {
          success: true,
          platform: 'instagram',
          endpoint: '/v1/instagram/profile',
          schema_version: '2',
          data: { dry_run: { credits_min: 20, credits_max: 20 } },
          unavailable: [],
          credits_used: 0,
          credits_remaining: 980,
          request_id: 'req_3',
          charge_reason: 'dry_run',
        },
      }),
    });
    const res = await call('call_endpoint', { path: '/v1/instagram/profile', params: { handle: 'x', dry_run: true } });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ charge_reason: 'dry_run', credits_used: 0, data: { dry_run: { credits_min: 20 } } });
    expect(res.body.unavailable).toBeUndefined();
    expect(calls.find((c) => c.url.pathname === '/v1/instagram/profile')!.url.searchParams.get('dry_run')).toBe('1');
  });

  it('replaces an oversized view with an outline', async () => {
    const big = postsEnvelope({ data: { items: Array.from({ length: 50 }, (_, i) => ({ post: { id: i, text: 'x'.repeat(2000) } })) } });
    const { call } = await connect('isk_live_test', { '/v1/instagram/profile/posts': () => ({ body: big }) });
    const res = await call('call_endpoint', { path: '/v1/instagram/profile/posts', params: { handle: 'x' }, max_items: 50 });
    expect(res.body.note).toContain('outline');
    expect(res.body.data.items._type).toBe('array[50]');
  });
});
