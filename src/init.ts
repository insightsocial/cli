import { execFile } from 'node:child_process';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SKILL_NAMES = ['insightsocial'];

/**
 * The MCP server is launched over stdio and reads the key from
 * ~/.insightsocial/config.json, so no agent config ever holds a secret.
 */
export const MCP_COMMAND = { command: 'npx', args: ['-y', 'insightsocial', 'mcp'] };

export type AgentId = 'claude' | 'codex' | 'cursor';

interface AgentDefinition {
  id: AgentId;
  label: string;
  home: string;
  command?: string;
}

export interface Agent extends AgentDefinition {
  homePath: string;
  detected: boolean;
  commandFound: boolean;
}

const AGENTS: AgentDefinition[] = [
  { id: 'claude', label: 'Claude Code', home: '.claude', command: 'claude' },
  { id: 'codex', label: 'Codex', home: '.codex' },
  { id: 'cursor', label: 'Cursor', home: '.cursor' },
];

export async function detectAgents(home = homedir()): Promise<Agent[]> {
  return Promise.all(
    AGENTS.map(async (agent) => {
      const homePath = join(home, agent.home);
      const homeExists = await exists(homePath);
      const commandFound = agent.command ? await hasCommand(agent.command) : false;
      return { ...agent, homePath, detected: homeExists, commandFound };
    }),
  );
}

function skillsSourceDir(): string {
  return fileURLToPath(new URL('../skills', import.meta.url));
}

export async function installSkills(agents: Agent[]): Promise<string[]> {
  const installed: string[] = [];
  for (const agent of agents.filter((a) => a.detected)) {
    const root = join(agent.homePath, 'skills');
    await mkdir(root, { recursive: true });
    for (const name of SKILL_NAMES) {
      await cp(join(skillsSourceDir(), name), join(root, name), { recursive: true, force: true });
    }
    installed.push(`${agent.label}: ${join(root, SKILL_NAMES[0]!)}`);
  }
  return installed;
}

export function mcpSnippet(agent: AgentId | 'json'): string {
  if (agent === 'claude') return `claude mcp add insightsocial --scope user -- ${MCP_COMMAND.command} ${MCP_COMMAND.args.join(' ')}`;
  if (agent === 'codex') return tomlBlock();
  return JSON.stringify({ mcpServers: { insightsocial: MCP_COMMAND } }, null, 2);
}

/** Write the MCP entry into each detected agent's own config. */
export async function configureMcp(agents: Agent[]): Promise<string[]> {
  const done: string[] = [];
  for (const agent of agents.filter((a) => a.detected)) {
    if (agent.id === 'claude') {
      if (!agent.commandFound) continue;
      // `add` refuses a name that exists; remove first so a re-run updates it.
      await execFileAsync('claude', ['mcp', 'remove', 'insightsocial', '--scope', 'user']).catch(() => undefined);
      await execFileAsync('claude', ['mcp', 'add', 'insightsocial', '--scope', 'user', '--', MCP_COMMAND.command, ...MCP_COMMAND.args]);
      done.push(`${agent.label}: claude mcp add insightsocial (user scope)`);
    } else if (agent.id === 'cursor') {
      const target = join(agent.homePath, 'mcp.json');
      await patchJson(target);
      done.push(`${agent.label}: ${target}`);
    } else if (agent.id === 'codex') {
      const target = join(agent.homePath, 'config.toml');
      await patchToml(target);
      done.push(`${agent.label}: ${target}`);
    }
  }
  return done;
}

function tomlBlock(): string {
  return [
    '[mcp_servers.insightsocial]',
    `command = "${MCP_COMMAND.command}"`,
    `args = [${MCP_COMMAND.args.map((a) => `"${a}"`).join(', ')}]`,
  ].join('\n');
}

export async function patchJson(target: string): Promise<void> {
  let root: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(target, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) root = parsed as Record<string, unknown>;
  } catch {
    // Missing or unreadable: start fresh rather than refuse.
  }
  const servers = (root.mcpServers && typeof root.mcpServers === 'object' ? root.mcpServers : {}) as Record<string, unknown>;
  root.mcpServers = { ...servers, insightsocial: MCP_COMMAND };
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
}

export async function patchToml(target: string): Promise<void> {
  let current = '';
  try {
    current = await readFile(target, 'utf8');
  } catch {
    current = '';
  }
  const block = tomlBlock();
  const pattern = /\[mcp_servers\.insightsocial\][\s\S]*?(?=\n\[|$)/;
  const next = pattern.test(current) ? current.replace(pattern, block) : `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}\n`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, next, 'utf8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hasCommand(command: string): Promise<boolean> {
  try {
    await execFileAsync('sh', ['-c', `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}
