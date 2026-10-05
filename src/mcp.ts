import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { agentSlug, ApiError, InsightSocialClient, errorMessage, isRecord, type CallEnvelope } from './api.js';
import {
  describeEndpoint,
  findEndpoint,
  nextPageParams,
  normalizeParams,
  searchEndpoints,
  suggestPaths,
  summarizeEndpoint,
  validateParams,
} from './catalogue.js';
import { resolveBaseUrl, resolveKey } from './config.js';
import { BILLING_URL, MCP_KEYS_URL, PLATFORMS, VERSION } from './constants.js';
import { itemCount, loadResult, mcpResultsDir, resultFile, saveResult } from './results.js';
import { JqError, shape, summarize } from './shape.js';

/** Past this, a tool answer is replaced by its outline: a 48KB page of posts would swamp the context. */
const MAX_TOOL_CHARS = 24_000;
const DEFAULT_MAX_ITEMS = 10;

export const INSTRUCTIONS = `InsightSocial: live public data from Instagram, TikTok, LinkedIn, Facebook, YouTube, X/Twitter, Reddit, Threads and Pinterest through one API key.

Workflow:
1. search_endpoints to find the endpoint (free). Paths look like /v1/instagram/profile.
2. describe_endpoint to read its inputs and price (free) when the search line is not enough.
3. call_endpoint to fetch (costs credits; the price is in the catalogue). The FULL response is saved locally and you get a result_id plus a trimmed view (10 items by default).
4. read_result to re-slice a saved result with jq, fields or max_items. It is free: never call an endpoint again just to see a different part of a result you already have.

Paging: when a response has pagination.has_more, call the same path again with the next_call params returned. Each page is charged.
Responses follow schema 2. A path listed in "unavailable" (e.g. items[].post.engagement.views) could not be filled by this response: its null means unknown, not zero.
Charging: every call that returns data is charged, a repeat of the same call included (often at full price again; a shared-cache hit costs 2). Keep and re-read results instead of repeating calls. The one free repeat is an idempotency replay: send the same idempotency_key when retrying a call that may already have succeeded.
Free: dry_run=1 quotes on any endpoint (returns data.dry_run {credits_min, credits_max}), empty results, failed calls, get_credits and the catalogue. A new account also gets 10 free calls: a covered call returns free_call: true and credits_used: 0.
Each call_endpoint result carries charge_reason (miss, shared_cache, replay, no_result, dry_run) and free_call, which say why it cost what it did.
Prices are in InsightSocial credits. A metered endpoint shows a {min,max} range and charges what the call actually cost.`;

function text(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function failure(message: string, extra?: Record<string, unknown>): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 2) }], isError: true };
}

function apiFailure(error: unknown): ReturnType<typeof failure> {
  if (error instanceof ApiError) {
    return failure(error.message, {
      type: error.type,
      status: error.status,
      ...(error.param ? { param: error.param } : {}),
      ...(error.requestId ? { request_id: error.requestId } : {}),
      ...(error.hint ? { next_step: error.hint } : {}),
    });
  }
  if (error instanceof JqError) return failure(`jq: ${error.message}`, { next_step: 'Fix the expression; the saved result is untouched.' });
  return failure(errorMessage(error));
}

/** Keep an answer inside the context budget: fall back to an outline with a pointer. */
function fit(payload: Record<string, unknown>, shapedKey: string): Record<string, unknown> {
  const rendered = JSON.stringify(payload);
  if (rendered.length <= MAX_TOOL_CHARS) return payload;
  return {
    ...payload,
    [shapedKey]: summarize(payload[shapedKey]),
    note: `The view was ${rendered.length} characters, so it is shown as an outline (types and byte sizes). Use read_result with jq, fields or a smaller max_items to pull what you need.`,
  };
}

export interface McpDeps {
  client: InsightSocialClient;
  resultsDir: string;
}

export function createServer(deps: McpDeps): McpServer {
  const { client, resultsDir } = deps;
  const server = new McpServer({ name: 'insightsocial', version: VERSION }, { instructions: INSTRUCTIONS });

  const platform = z.enum(PLATFORMS).optional().describe('Limit to one platform.');
  const fields = z
    .array(z.string())
    .optional()
    .describe('Keep only these keys on each item, e.g. ["username","followers","ext.public_email"]. Dotted paths descend.');
  const jq = z.string().optional().describe('A jq expression over the saved response envelope, e.g. ".data.items[] | {id, text}".');

  server.registerTool(
    'search_endpoints',
    {
      title: 'Search endpoints',
      description:
        'Find InsightSocial API endpoints by keywords and/or platform. Returns path, price in credits, required inputs and whether it paginates. Free.',
      inputSchema: {
        query: z.string().optional().describe('Words such as "instagram followers", "tiktok comments", "linkedin company jobs".'),
        platform,
        limit: z.number().int().min(1).max(50).optional().describe('How many results (default 10).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, platform: p, limit }) => {
      try {
        const catalogue = await client.catalogue();
        const hits = searchEndpoints(catalogue, query ?? '', { platform: p, limit: limit ?? 10 });
        if (hits.length === 0) {
          return text({ endpoints: [], note: `Nothing matched. Try fewer or broader words, or one of: ${PLATFORMS.join(', ')}.` });
        }
        return text({ endpoints: hits.map((h) => summarizeEndpoint(h.endpoint)) });
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    'describe_endpoint',
    {
      title: 'Describe an endpoint',
      description: 'The full contract of one endpoint: what it returns, every input with its type, allowed values and an example, and its price. Free.',
      inputSchema: { path: z.string().describe('e.g. /v1/instagram/profile') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      try {
        const catalogue = await client.catalogue();
        const endpoint = findEndpoint(catalogue, path);
        if (!endpoint) return failure(`No endpoint ${path}.`, { did_you_mean: suggestPaths(catalogue, path) });
        return text(describeEndpoint(endpoint));
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    'call_endpoint',
    {
      title: 'Call an endpoint',
      description:
        'Fetch live data from one endpoint. Costs the credits listed in the catalogue (empty results and failures are free). The full response is saved and a result_id is returned with a trimmed view; use read_result to see more of it for free.',
      inputSchema: {
        path: z.string().describe('Endpoint path, e.g. /v1/instagram/profile'),
        params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe('Query inputs, e.g. {"handle":"natgeo"}'),
        idempotency_key: z
          .string()
          .optional()
          .describe('Send the same key to retry safely: a replay returns the original response and is charged 0.'),
        fresh: z.boolean().optional().describe('Bypass caches and fetch fresh. Always charged.'),
        fields,
        max_items: z.number().int().min(0).max(500).optional().describe(`Items shown in the view (default ${DEFAULT_MAX_ITEMS}). The saved result is always complete.`),
        jq,
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
    },
    async ({ path, params: given = {}, idempotency_key, fresh, fields: f, max_items, jq: expr }) => {
      try {
        if (!client.hasKey) {
          return failure('No API key configured, so endpoints cannot be called (search and describe still work).', {
            next_step: `Get a key at ${MCP_KEYS_URL}, then run "npx -y insightsocial login" or set INSIGHTSOCIAL_API_KEY in this MCP server's env.`,
          });
        }
        const catalogue = await client.catalogue();
        const endpoint = findEndpoint(catalogue, path);
        if (!endpoint) return failure(`No endpoint ${path}.`, { did_you_mean: suggestPaths(catalogue, path) });
        if (!endpoint.available) return failure(`${endpoint.path} is listed but cannot be called yet.`);
        const params = normalizeParams(endpoint, given);
        const problems = validateParams(endpoint, params);
        if (problems.length > 0) {
          return failure(`Invalid inputs for ${endpoint.path}: ${problems.join('; ')}.`, {
            next_step: 'describe_endpoint shows every input. Nothing was charged.',
          });
        }

        const envelope = await client.call(endpoint.path, params, { idempotencyKey: idempotency_key, fresh });
        const saved = await saveResult(resultsDir, envelope, { path: endpoint.path, params });
        const view = await shape(expr ? envelope : envelope.data, {
          jq: expr,
          fields: f,
          maxItems: expr ? max_items : (max_items ?? DEFAULT_MAX_ITEMS),
        });
        return text(fit({ ...meta(envelope, saved.id, endpoint.path, nextPageParams(endpoint, params, envelope.pagination)), [expr ? 'result' : 'data']: view }, expr ? 'result' : 'data'));
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    'read_result',
    {
      title: 'Read a saved result',
      description:
        'Re-slice a result saved by call_endpoint: jq, fields, max_items, or summary for an outline with byte sizes. Local and free. Never call the endpoint again just to see a different part.',
      inputSchema: {
        result_id: z.string().describe('The result_id returned by call_endpoint.'),
        jq,
        fields,
        max_items: z.number().int().min(0).max(1000).optional(),
        summary: z.boolean().optional().describe('An outline of the structure with byte sizes, instead of values.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ result_id, jq: expr, fields: f, max_items, summary }) => {
      try {
        const saved = await loadResult(resultFile(resultsDir, result_id, { allowPaths: false }));
        const view = await shape(expr || summary ? saved : saved.data, { jq: expr, fields: f, maxItems: max_items, summary });
        return text(fit({ result_id, endpoint: saved.endpoint, items: itemCount(saved), result: view }, 'result'));
      } catch (error) {
        if (isRecord(error) && error.code === 'ENOENT') return failure(`No saved result ${result_id}.`);
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    'get_credits',
    {
      title: 'Credit balance',
      description: 'Remaining credits, plan and this period’s usage for the configured key. Free.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        if (!client.hasKey) return failure('No API key configured.', { next_step: `Get one at ${MCP_KEYS_URL}` });
        const credits = await client.credits();
        delete credits.success;
        return text({ ...credits, top_up: BILLING_URL });
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  return server;
}

/** The facts an agent needs to budget and to ask for the next page. */
export function meta(
  envelope: CallEnvelope,
  resultId: string,
  path: string,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const pagination = envelope.pagination;
  return {
    result_id: resultId,
    endpoint: path,
    ...(envelope.schema_version ? { schema_version: envelope.schema_version } : {}),
    items: itemCount(envelope),
    credits_used: envelope.credits_used,
    credits_remaining: envelope.credits_remaining,
    request_id: envelope.request_id,
    // Why it cost what it did: an agent budgeting a loop needs both.
    ...(envelope.charge_reason ? { charge_reason: envelope.charge_reason } : {}),
    ...(typeof envelope.free_call === 'boolean' ? { free_call: envelope.free_call } : {}),
    ...(envelope.idempotent_replay ? { idempotent_replay: true } : {}),
    // Fields this response could not fill: their null means unknown, not zero.
    ...(envelope.unavailable?.length ? { unavailable: envelope.unavailable } : {}),
    ...(pagination
      ? {
          pagination: {
            has_more: Boolean(pagination.has_more),
            ...(pagination.page_size !== undefined ? { page_size: pagination.page_size } : {}),
            // The next request, ready to send. Without it an agent has to know
            // that this endpoint calls its cursor `next_max_id`.
            ...(next ? { next_call: { path, params: next } } : pagination.has_more ? { next_cursor: pagination.next_cursor } : {}),
          },
        }
      : {}),
  };
}

export async function runMcpServer(): Promise<void> {
  const key = await resolveKey(undefined);
  // The agent is only known once it has sent initialize, after this client
  // exists, so the client asks for it on every request.
  let server: McpServer | undefined;
  const client = new InsightSocialClient({
    baseUrl: await resolveBaseUrl(),
    apiKey: key?.key,
    surface: 'mcp',
    agent: () => agentSlug(server?.server.getClientVersion()?.name),
  });
  server = createServer({ client, resultsDir: mcpResultsDir() });
  await server.connect(new StdioServerTransport());
  // stdout is the transport; anything human goes to stderr.
  process.stderr.write(`insightsocial mcp ${VERSION} ready${key ? '' : ' (no API key: search and describe only)'}\n`);
}
