import { mkdtemp, readFile, stat, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { clearStoredKey, maskKey, resolveKey, writeStoredConfig } from '../src/config.js';
import { patchJson, patchToml } from '../src/init.js';
import { latestResult, resultFile, saveResult } from '../src/results.js';
import { postsEnvelope } from './fixtures.js';

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'is-cli-'));
  env = { INSIGHTSOCIAL_HOME: home };
});

describe('resolveKey', () => {
  it('prefers flag, then env, then the saved config', async () => {
    await writeStoredConfig({ apiKey: 'isk_live_saved' }, env);
    expect(await resolveKey('isk_live_flag', env)).toEqual({ key: 'isk_live_flag', source: 'flag' });
    expect(await resolveKey(undefined, { ...env, INSIGHTSOCIAL_API_KEY: 'isk_live_env' })).toEqual({ key: 'isk_live_env', source: 'env' });
    // An MCP client that expands an unset ${VAR:-} passes an empty string: fall through.
    expect(await resolveKey(undefined, { ...env, INSIGHTSOCIAL_API_KEY: '' })).toEqual({ key: 'isk_live_saved', source: 'config' });
  });

  it('writes the config readable only by the owner, and clears it', async () => {
    await writeStoredConfig({ apiKey: 'isk_live_saved' }, env);
    expect((await stat(join(home, 'config.json'))).mode & 0o777).toBe(0o600);
    await clearStoredKey(env);
    expect(await resolveKey(undefined, env)).toBeUndefined();
  });

  it('masks keys', () => {
    expect(maskKey('isk_live_HAXvVSQIYDhkcJnA')).toBe('isk_live_••••cJnA');
  });
});

describe('results', () => {
  it('saves with the request, and finds the newest per endpoint without prefix collisions', async () => {
    const dir = join(home, 'r');
    const a = await saveResult(dir, postsEnvelope() as never, { path: '/v1/instagram/profile/posts', params: { handle: 'x' } });
    const b = await saveResult(dir, postsEnvelope() as never, { path: '/v1/instagram/profile', params: { handle: 'x' } });
    await utimes(a.file, new Date(), new Date(Date.now() + 5000));
    expect(await latestResult(dir)).toBe(a.file);
    expect(await latestResult(dir, 'instagram/profile')).toBe(b.file);
    expect(await latestResult(dir, '/v1/instagram/profile/posts')).toBe(a.file);
    const saved = JSON.parse(await readFile(a.file, 'utf8'));
    expect(saved.request).toMatchObject({ path: '/v1/instagram/profile/posts', params: { handle: 'x' } });
    expect(resultFile(dir, a.id)).toBe(a.file);
  });

  it('refuses result ids that could escape the directory', () => {
    expect(() => resultFile('/tmp/r', '..%2f..')).toThrow();
    expect(() => resultFile('/tmp/r', '../../etc/x.json', { allowPaths: false })).toThrow();
    expect(resultFile('/tmp/r', './x.json')).toMatch(/x\.json$/);
  });
});

describe('agent config patchers', () => {
  it('adds to an existing mcp.json without touching other servers', async () => {
    const file = join(home, 'cursor', 'mcp.json');
    await mkdir(join(home, 'cursor'));
    await writeFile(file, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    await patchJson(file);
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(parsed.mcpServers)).toEqual(['other', 'insightsocial']);
    expect(parsed.mcpServers.insightsocial.args).toEqual(['-y', 'insightsocial', 'mcp']);
  });

  it('replaces its own block in config.toml on a re-run', async () => {
    const file = join(home, 'config.toml');
    await writeFile(file, 'model = "x"\n\n[mcp_servers.insightsocial]\ncommand = "old"\n\n[other]\na = 1\n');
    await patchToml(file);
    const text = await readFile(file, 'utf8');
    expect(text.match(/\[mcp_servers\.insightsocial\]/g)).toHaveLength(1);
    expect(text).toContain('args = ["-y", "insightsocial", "mcp"]');
    expect(text).toContain('[other]');
    expect(text).not.toContain('"old"');
  });
});

describe('looksLikeKey', () => {
  it('accepts real keys, which are base64url and usually contain - or _', async () => {
    const { looksLikeKey } = await import('../src/config.js');
    expect(looksLikeKey('isk_live_Ab3-x_Y9pQ2rS7tU1vW4xZ6aB8cD0eF2gH4iJ6kL8mN')).toBe(true);
    expect(looksLikeKey('isk_test_abcdefghijklmnop')).toBe(true);
    expect(looksLikeKey('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig')).toBe(false);
    expect(looksLikeKey('isk_live_short')).toBe(false);
  });
});
