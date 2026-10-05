#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';

import { Command, Option } from 'commander';

import { ApiError, InsightSocialClient, chargeLine, defaultCacheDir, errorMessage, formatCredits, type Endpoint } from './api.js';
import {
  describeEndpoint,
  endpointLine,
  findEndpoint,
  nextPageParams,
  normalizeParams,
  resolvePlatform,
  searchEndpoints,
  suggestPaths,
  validateParams,
} from './catalogue.js';
import { clearStoredKey, looksLikeKey, maskKey, readStoredConfig, resolveBaseUrl, resolveKey, writeStoredConfig } from './config.js';
import { API_KEY_ENV, BILLING_URL, DOCS_URL, PLATFORMS, VERSION } from './constants.js';
import { configureMcp, detectAgents, installSkills, mcpSnippet } from './init.js';
import { deviceLogin, DeviceLoginError } from './device-login.js';
import { runMcpServer } from './mcp.js';
import { cliResultsDir, itemCount, latestResult, loadResult, saveResult } from './results.js';
import { JqError, shape } from './shape.js';

class UsageError extends Error {}

const out = (line = ''): void => void process.stdout.write(`${line}\n`);
const err = (line = ''): void => void process.stderr.write(`${line}\n`);
const printJson = (value: unknown, compact = false): void => out(JSON.stringify(value, null, compact ? 0 : 2));

async function makeClient(apiKeyFlag?: string): Promise<InsightSocialClient> {
  const key = await resolveKey(apiKeyFlag);
  return new InsightSocialClient({
    baseUrl: await resolveBaseUrl(),
    apiKey: key?.key,
    surface: 'cli',
    cacheDir: defaultCacheDir(),
  });
}

async function endpointOrExit(client: InsightSocialClient, path: string): Promise<Endpoint> {
  const catalogue = await client.catalogue();
  const endpoint = findEndpoint(catalogue, path);
  if (!endpoint) {
    const near = suggestPaths(catalogue, path);
    throw new UsageError(`No endpoint ${path}.${near.length ? ` Did you mean:\n  ${near.join('\n  ')}` : ''}`);
  }
  return endpoint;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseParams(pairs: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new UsageError(`-p expects name=value, got "${pair}"`);
    params[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return params;
}

async function readInput(inline?: string, file?: string): Promise<Record<string, unknown>> {
  const raw = file ? await readFile(file, 'utf8') : inline;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new UsageError('--input must be a JSON object, e.g. \'{"handle":"natgeo"}\'');
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function maxCredits(endpoint: Endpoint): number {
  return typeof endpoint.credits === 'number' ? endpoint.credits : endpoint.credits.max;
}

/** Check a key against /v1/credits before saving it, so a typo fails now rather than on the first paid call. */
async function verifyAndSave(key: string): Promise<void> {
  if (!looksLikeKey(key)) throw new UsageError('That does not look like an InsightSocial key (isk_live_… or isk_test_…).');
  const client = new InsightSocialClient({ baseUrl: await resolveBaseUrl(), apiKey: key, surface: 'cli' });
  const credits = await client.credits();
  const current = await readStoredConfig();
  const path = await writeStoredConfig({ ...current, apiKey: key });
  out(`Saved ${maskKey(key)} to ${path}`);
  if (typeof credits.credits_remaining === 'number') out(`Balance: ${credits.credits_remaining.toLocaleString('en-US')} credits`);
}

const program = new Command();
program
  .name('insightsocial')
  .description(`Live social data from ${PLATFORMS.length} platforms through one API key. Docs: ${DOCS_URL}`)
  .version(VERSION)
  .addOption(new Option('--api-key <key>', `API key (default: $${API_KEY_ENV}, then ~/.insightsocial/config.json)`));

/* --------------------------------------------------------------- auth -- */

/**
 * Sign in through the browser and return the key it hands out (device-login.ts).
 * Says which account approved it: whoever enters the code first owns the key,
 * so a user has to be able to see when that was not them.
 */
async function browserLogin(openBrowser: boolean): Promise<string> {
  const { key, email } = await deviceLogin({ baseUrl: await resolveBaseUrl(), log: err, openBrowser });
  if (email) out(`Signed in as ${email}. Not you? Run "insightsocial logout", then log in again.`);
  return key;
}

program
  .command('login')
  .description('Sign in through your browser and save a key for this machine (or save one you pass with --api-key)')
  .option('--api-key <key>', 'save this key instead of signing in through the browser')
  .option('--no-browser', 'print the sign-in link without opening a browser')
  .action(async (opts: { apiKey?: string; browser: boolean }) => {
    const key = opts.apiKey ?? program.opts().apiKey ?? (await browserLogin(opts.browser));
    await verifyAndSave(key);
  });

program
  .command('logout')
  .description('Remove the saved API key')
  .action(async () => {
    await clearStoredKey();
    out('Removed the saved key.');
  });

/* ----------------------------------------------------------- discovery -- */

program
  .command('search')
  .description('Find endpoints by keywords, e.g. "instagram followers" (free)')
  .argument('[query...]', 'words to search for')
  .option('--platform <platform>', `one of ${PLATFORMS.join(', ')}`)
  .option('--limit <n>', 'how many results', '15')
  .option('--json', 'machine-readable output')
  .action(async (words: string[], opts: { platform?: string; limit: string; json?: boolean }) => {
    const client = await makeClient(program.opts().apiKey);
    const catalogue = await client.catalogue();
    if (opts.platform && !resolvePlatform(opts.platform)) throw new UsageError(`Unknown platform "${opts.platform}".`);
    const hits = searchEndpoints(catalogue, words.join(' '), { platform: opts.platform, limit: Number(opts.limit) || 15 });
    if (opts.json) return printJson(hits.map((h) => describeEndpoint(h.endpoint)));
    if (hits.length === 0) return out('No endpoints matched. Try broader words, or: insightsocial list --platform <platform>');
    for (const hit of hits) out(endpointLine(hit.endpoint));
    out();
    out('Details: insightsocial describe <path>');
  });

program
  .command('list')
  .description('List endpoints, optionally for one platform (free)')
  .option('--platform <platform>', `one of ${PLATFORMS.join(', ')}`)
  .option('--json', 'machine-readable output')
  .action(async (opts: { platform?: string; json?: boolean }) => {
    const client = await makeClient(program.opts().apiKey);
    const catalogue = await client.catalogue();
    const platform = resolvePlatform(opts.platform);
    if (opts.platform && !platform) throw new UsageError(`Unknown platform "${opts.platform}".`);
    const endpoints = catalogue.endpoints.filter((e) => !platform || e.platform === platform);
    if (opts.json) return printJson(endpoints.map(describeEndpoint));
    let current = '';
    for (const endpoint of endpoints) {
      if (endpoint.platform !== current) {
        current = endpoint.platform;
        out(`\n${current}`);
      }
      out(`  ${endpointLine(endpoint)}`);
    }
    out(`\n${endpoints.length} endpoints. Prices are in credits.`);
  });

program
  .command('describe')
  .description('Inputs, example and price for one endpoint (free)')
  .argument('<path>', 'e.g. /v1/instagram/profile or instagram/profile')
  .option('--json', 'machine-readable output')
  .action(async (path: string, opts: { json?: boolean }) => {
    const client = await makeClient(program.opts().apiKey);
    const endpoint = await endpointOrExit(client, path);
    if (opts.json) return printJson(describeEndpoint(endpoint));
    out(`${endpoint.method} ${endpoint.path}`);
    out(`${formatCredits(endpoint.credits)} credits${typeof endpoint.credits === 'number' ? '' : ' (metered: charged what the call cost)'}${endpoint.paginates ? ' per page' : ''}`);
    if (!endpoint.available) out('Not callable yet.');
    out();
    out(endpoint.description);
    out();
    out('Inputs:');
    for (const p of endpoint.params) {
      const tags = [p.required ? 'required' : p.one_of_group ? `one of ${p.one_of_group}` : 'optional', p.type].filter(Boolean).join(', ');
      out(`  ${p.name} (${tags})`);
      out(`      ${p.help ?? p.description ?? ''}`);
      if (p.enum) out(`      values: ${p.enum.join(', ')}`);
      if (p.example !== undefined) out(`      example: ${String(p.example)}`);
    }
    const example = endpoint.params
      .filter((p) => p.required || (p.one_of_group && endpoint.params.find((q) => q.one_of_group === p.one_of_group) === p))
      .map((p) => `-p ${p.name}=${shellQuote(String(p.example ?? `<${p.name}>`))}`)
      .join(' ');
    out();
    out(`Run: insightsocial run ${endpoint.path}${example ? ` ${example}` : ''}`);
  });

/* ----------------------------------------------------------------- run -- */

interface ShapeFlags {
  jq?: string;
  fields?: string;
  maxItems?: string;
  summary?: boolean;
}

function shapeOptions(flags: ShapeFlags): Parameters<typeof shape>[1] {
  const maxItems = flags.maxItems !== undefined ? Number(flags.maxItems) : undefined;
  if (maxItems !== undefined && (!Number.isInteger(maxItems) || maxItems < 0)) throw new UsageError('--max-items must be a whole number.');
  return {
    jq: flags.jq,
    fields: flags.fields?.split(',').map((f) => f.trim()).filter(Boolean),
    maxItems,
    summary: flags.summary,
  };
}

function hasShaping(flags: ShapeFlags): boolean {
  return Boolean(flags.jq || flags.fields || flags.maxItems !== undefined || flags.summary);
}

program
  .command('run')
  .description('Call an endpoint. The full response is saved to ./.insightsocial/; shaping flags trim only what is printed')
  .argument('<path>', 'e.g. /v1/instagram/profile')
  .option('-p, --param <name=value>', 'an input; repeatable', collect, [])
  .option('--input <json>', 'inputs as a JSON object')
  .option('-i, --input-file <file>', 'inputs from a JSON file')
  .option('--idempotency-key <key>', 'retry safely: a replay with the same key is returned unchanged and charged 0')
  .option('--fresh', 'bypass caches (always charged)')
  .option('--max-credits <n>', 'refuse to run if the endpoint can cost more than this')
  .option('--jq <expr>', 'jq over the saved response, e.g. ".data.items[] | {id}"')
  .option('--fields <a,b.c>', 'keep only these keys on each item')
  .option('--max-items <n>', 'show at most N items')
  .option('--summary', 'print an outline with byte sizes instead of values')
  .option('-o, --out <file>', 'save to this file instead of ./.insightsocial/')
  .option('--json', 'print the full response as JSON (still saved)')
  .action(async (path: string, opts: ShapeFlags & {
    param: string[];
    input?: string;
    inputFile?: string;
    idempotencyKey?: string;
    fresh?: boolean;
    maxCredits?: string;
    out?: string;
    json?: boolean;
  }) => {
    const client = await makeClient(program.opts().apiKey);
    if (!client.hasKey) throw new ApiError(401, 'MISSING_KEY', 'No API key configured.');
    const endpoint = await endpointOrExit(client, path);
    if (!endpoint.available) throw new UsageError(`${endpoint.path} is listed but cannot be called yet.`);

    const params = normalizeParams(endpoint, { ...(await readInput(opts.input, opts.inputFile)), ...parseParams(opts.param) });
    const problems = validateParams(endpoint, params);
    if (problems.length) throw new UsageError(`Invalid inputs for ${endpoint.path}:\n  ${problems.join('\n  ')}\nSee: insightsocial describe ${endpoint.path}`);

    if (opts.maxCredits !== undefined && maxCredits(endpoint) > Number(opts.maxCredits)) {
      throw new UsageError(`${endpoint.path} can cost up to ${maxCredits(endpoint)} credits, above --max-credits ${opts.maxCredits}. Nothing was charged.`);
    }

    const envelope = await client.call(endpoint.path, params, { idempotencyKey: opts.idempotencyKey, fresh: opts.fresh });
    const saved = await saveResult(cliResultsDir(), envelope, { path: endpoint.path, params }, opts.out);

    if (opts.json) {
      printJson(envelope);
      err(`saved ${saved.file}`);
      return;
    }

    const count = itemCount(envelope);
    out(`saved    ${relative(process.cwd(), saved.file) || saved.file}`);
    if (count !== undefined) out(`items    ${count}`);
    out(`credits  ${envelope.credits_used} used, ${envelope.credits_remaining.toLocaleString('en-US')} left${envelope.idempotent_replay ? ' (replay)' : ''}`);
    const charge = chargeLine(envelope);
    if (charge) out(`charge   ${charge}`);
    out(`request  ${envelope.request_id}`);
    const quote = dryRunQuote(envelope.data);
    if (quote) out(`quote    ${quote} credits (dry run, nothing charged)`);
    if (envelope.unavailable?.length) out(`missing  ${envelope.unavailable.join(', ')} (not filled by this response; null is not 0)`);
    const next = nextPageParams(endpoint, params, envelope.pagination);
    if (next) {
      out(`next     insightsocial run ${endpoint.path} ${Object.entries(next).map(([k, v]) => `-p ${k}=${shellQuote(String(v))}`).join(' ')}`);
    } else if (envelope.pagination?.has_more) {
      out('next     more results exist; see pagination in the saved file');
    }

    if (hasShaping(opts)) {
      out();
      printJson(await shape(opts.jq || opts.summary ? envelope : envelope.data, shapeOptions(opts)));
    } else {
      out();
      out(`Inspect for free: insightsocial view --last --summary`);
    }
  });

/** `data.dry_run` as "20–1300", when the call was a dry run. */
function dryRunQuote(data: unknown): string | undefined {
  const quote = (data as { dry_run?: { credits_min?: number; credits_max?: number } } | undefined)?.dry_run;
  if (!quote || typeof quote.credits_min !== 'number' || typeof quote.credits_max !== 'number') return undefined;
  return formatCredits(quote.credits_min === quote.credits_max ? quote.credits_min : { min: quote.credits_min, max: quote.credits_max });
}

program
  .command('view')
  .description('Re-shape a saved result locally: no network, no charge')
  .argument('[file]', 'a saved result file (default: the newest)')
  .option('--last [endpoint]', 'newest saved result, optionally for one endpoint')
  .option('--jq <expr>', 'jq over the saved response')
  .option('--fields <a,b.c>', 'keep only these keys on each item')
  .option('--max-items <n>', 'show at most N items')
  .option('--summary', 'outline with byte sizes')
  .option('--json', 'compact output')
  .action(async (file: string | undefined, opts: ShapeFlags & { last?: string | boolean; json?: boolean }) => {
    const dir = cliResultsDir();
    const target = file ?? (await latestResult(dir, typeof opts.last === 'string' ? opts.last : undefined));
    if (!target) throw new UsageError(`No saved results in ${dir}. Run an endpoint first: insightsocial run <path>`);
    const saved = await loadResult(target);
    err(`${target}`);
    const view = hasShaping(opts) ? await shape(opts.jq || opts.summary ? saved : saved.data, shapeOptions(opts)) : saved;
    printJson(view, opts.json);
  });

program
  .command('credits')
  .alias('balance')
  .description('Remaining credits and this period’s usage (free)')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    const client = await makeClient(program.opts().apiKey);
    const credits = await client.credits();
    if (opts.json) return printJson(credits);
    const plan = credits.plan as { tier?: string; resets_at?: string } | undefined;
    const free = credits.free_calls as { remaining?: number; total?: number } | undefined;
    out(`credits   ${Number(credits.credits_remaining ?? 0).toLocaleString('en-US')}`);
    if (plan?.tier) out(`plan      ${plan.tier}${plan.resets_at ? ` (resets ${plan.resets_at.slice(0, 10)})` : ''}`);
    if (free && (free.remaining ?? 0) > 0) out(`free      ${free.remaining} of ${free.total} trial calls left`);
    out(`top up    ${BILLING_URL}`);
  });

/* ------------------------------------------------------- agents setup -- */

program
  .command('init')
  .description('Set up for AI agents: save a key, install the skill, and register the MCP server')
  .option('--yes', 'write the MCP config into each detected agent (default: print the snippets)')
  .option('--no-skills', 'do not install the skill')
  .action(async (opts: { yes?: boolean; skills: boolean }) => {
    const key = await resolveKey(program.opts().apiKey);
    if (key && key.source === 'flag') await verifyAndSave(key.key);
    else if (key) out(`Key: ${maskKey(key.key)} (from ${key.source === 'env' ? `$${API_KEY_ENV}` : '~/.insightsocial/config.json'})`);
    else {
      // No key yet: sign in through the browser. A run that cannot finish it
      // (no one at the browser) still sets up the skill and the MCP config.
      try {
        await verifyAndSave(await browserLogin(true));
      } catch (error) {
        if (!(error instanceof DeviceLoginError)) throw error;
        err(`Not signed in: ${error.message}`);
        out('Search and describe work without a key; run "insightsocial login" before calling endpoints.');
      }
    }

    const agents = await detectAgents();
    const found = agents.filter((a) => a.detected);
    out();
    out(`Agents found: ${found.length ? found.map((a) => a.label).join(', ') : 'none'}`);

    if (opts.skills && found.length) {
      for (const line of await installSkills(agents)) out(`skill    ${line}`);
    }

    out();
    if (opts.yes) {
      const done = await configureMcp(agents);
      for (const line of done) out(`mcp      ${line}`);
      if (done.length === 0) out('No agent config to write. Add the MCP server by hand:');
    }
    if (!opts.yes || found.length === 0) {
      out('MCP server (stdio). Claude Code:');
      out(`  ${mcpSnippet('claude')}`);
      out('Codex (~/.codex/config.toml):');
      out(mcpSnippet('codex').replace(/^/gm, '  '));
      out('Cursor, Claude Desktop, Windsurf and others (mcpServers JSON):');
      out(mcpSnippet('json').replace(/^/gm, '  '));
      if (!opts.yes && found.length) out('\nRun "insightsocial init --yes" to write these for you.');
    }
    out();
    out('Try it: insightsocial search instagram profile');
  });

program
  .command('mcp')
  .description('Start the MCP server over stdio (for agent configs; not for humans)')
  .action(async () => {
    await runMcpServer();
  });

/* ------------------------------------------------------------- errors -- */

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof ApiError) {
      const details = [error.param ? `param ${error.param}` : '', error.requestId ? `request ${error.requestId}` : ''].filter(Boolean);
      err(`error: ${error.message}${details.length ? ` (${details.join(', ')})` : ''}`);
      if (error.hint) err(error.hint);
      process.exitCode = 1;
    } else if (error instanceof UsageError || error instanceof DeviceLoginError) {
      err(`error: ${error.message}`);
      process.exitCode = 2;
    } else if (error instanceof JqError) {
      err(`jq: ${error.message}`);
      err('The saved result is untouched; fix the expression and use "insightsocial view".');
      process.exitCode = 1;
    } else {
      err(`error: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  }
}

void main();
