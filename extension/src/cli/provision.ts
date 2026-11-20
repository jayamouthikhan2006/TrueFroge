// `node extension/dist/provision.js [--config <dir>] [--env <file>]...`
//
// Registers the ForgeCode model providers (primary + fallback), the workspace
// MCP server, the SKILL.md packs (natively when TrueForge can run skills) and
// the forge-coding-agent definition with a running TrueForge server. Used by
// scripts/setup-trueforge.sh; the VS Code extension runs the same Provisioner.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadEnv } from '../trueforge/provisioning/env';
import { loadForgeConfig } from '../trueforge/provisioning/ForgeConfig';
import { Provisioner } from '../trueforge/provisioning/Provisioner';
import { TrueForgeRest } from '../trueforge/rest';
import { consoleSink, errorMessage, SinkLogger } from '../util/log';

interface CliArgs {
  configDir: string;
  envFiles: string[];
  skipAgent: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const repoRoot = resolve(dirname(__filename), '..', '..');
  const args: CliArgs = { configDir: join(repoRoot, 'trueforge-config'), envFiles: [], skipAgent: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') {
      args.configDir = resolve(argv[++i] ?? '');
    } else if (arg === '--env') {
      args.envFiles.push(resolve(argv[++i] ?? ''));
    } else if (arg === '--skip-agent') {
      args.skipAgent = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: provision [--config <trueforge-config dir>] [--env <.env file>]... [--skip-agent]\n');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.envFiles.length === 0) {
    args.envFiles.push(join(repoRoot, '.env'));
  }
  return args;
}

/** The MCP bearer token must be shared with the extension, so persist a generated one in .env. */
function ensureMcpToken(envFile: string, env: Record<string, string | undefined>): void {
  if (env.FORGECODE_MCP_TOKEN) {
    return;
  }
  const token = randomBytes(24).toString('hex');
  const prefix = existsSync(envFile) && !readFileSync(envFile, 'utf8').endsWith('\n') ? '\n' : '';
  appendFileSync(envFile, `${prefix}FORGECODE_MCP_TOKEN=${token}\n`);
  env.FORGECODE_MCP_TOKEN = token;
  process.stdout.write(`generated FORGECODE_MCP_TOKEN and saved it to ${envFile}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = new SinkLogger(consoleSink);
  const env = loadEnv(args.envFiles);
  ensureMcpToken(args.envFiles[0]!, env);

  const baseUrl = env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
  const rest = new TrueForgeRest({ baseUrl, apiKey: env.TRUEFORGE_API_KEY });
  const provisioner = new Provisioner(rest, log);
  await provisioner.ping().catch((error: unknown) => {
    throw new Error(`TrueForge is not reachable at ${baseUrl}: ${errorMessage(error)}`);
  });

  const config = loadForgeConfig(args.configDir, env);
  const skillsGit = env.FORGECODE_SKILLS_GIT_URL
    ? {
        url: env.FORGECODE_SKILLS_GIT_URL,
        ref: env.FORGECODE_SKILLS_GIT_REF ?? 'main',
        configPathInRepo: env.FORGECODE_SKILLS_GIT_PATH ?? 'trueforge-config',
      }
    : undefined;

  const report = await provisioner.provision(config, {
    registerProviders: true,
    registerAgent: !args.skipAgent,
    skillsGit,
  });

  const lines = [
    '',
    'ForgeCode provisioning summary',
    `  TrueForge:        ${baseUrl}`,
    `  primary model:    ${report.models.primary ?? '(not configured)'}`,
    `  fallback model:   ${report.models.fallback ?? '(not configured)'}`,
    `  providers:        ${report.providers.map((p) => p.name).join(', ') || '(none registered)'}`,
    ...report.skippedProviders.map((s) => `  skipped:          ${s.role} (${s.reason})`),
    `  MCP servers:      ${report.mcpServers.join(', ')}`,
    `  skills:           ${report.skillsMode === 'native' ? `native (${report.nativeSkills.join(', ')})` : `served via load_skill (${config.skills.map((s) => s.name).join(', ')})`}`,
    ...(report.skillsNote ? [`                    ${report.skillsNote}`] : []),
    `  agent:            ${report.agent ? `${report.agent.name} ${report.agent.created ? 'created' : 'updated'} (${report.agent.id})` : 'skipped'}`,
    `  models on server: ${report.availableModels.join(', ') || '(none)'}`,
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`provision failed: ${errorMessage(error)}\n`);
  process.exit(1);
});
