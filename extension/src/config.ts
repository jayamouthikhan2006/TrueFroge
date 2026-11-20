import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

export interface ForgeSettings {
  trueforgeBaseUrl: string;
  trueforgeApiKey: string;
  agentName: string;
  configDir: string;
  autoProvision: boolean;
  primaryModel: string;
  fallbackModel: string;
  failoverEnabled: boolean;
  firstEventTimeoutMs: number;
  tokenBudget: number;
  maxIndexedFiles: number;
  mcpPort: number;
  mcpHost: string;
  mcpAuthToken: string;
  allowedCommands: string[];
  terminalTimeoutMs: number;
  python: string;
}

export function readSettings(extensionPath: string): ForgeSettings {
  const c = vscode.workspace.getConfiguration('forgecode');
  const configured = c.get<string>('trueforge.configDir', '').trim();
  return {
    trueforgeBaseUrl: c.get<string>('trueforge.baseUrl', 'http://localhost:8790').replace(/\/+$/, ''),
    trueforgeApiKey: c.get<string>('trueforge.apiKey', ''),
    agentName: c.get<string>('trueforge.agentName', 'forge-coding-agent'),
    configDir: configured || defaultConfigDir(extensionPath),
    autoProvision: c.get<boolean>('trueforge.autoProvision', true),
    primaryModel: c.get<string>('models.primary', '').trim(),
    fallbackModel: c.get<string>('models.fallback', '').trim(),
    failoverEnabled: c.get<boolean>('failover.enabled', true),
    firstEventTimeoutMs: Math.max(5000, c.get<number>('failover.firstEventTimeoutMs', 120000)),
    tokenBudget: clamp(c.get<number>('context.tokenBudget', 6000), 500, 64000),
    maxIndexedFiles: Math.max(100, c.get<number>('context.maxIndexedFiles', 5000)),
    mcpPort: c.get<number>('mcp.port', 8791),
    mcpHost: c.get<string>('mcp.host', '127.0.0.1'),
    mcpAuthToken: c.get<string>('mcp.authToken', ''),
    allowedCommands: c.get<string[]>('terminal.allowedCommands', []),
    terminalTimeoutMs: Math.max(5000, c.get<number>('terminal.timeoutMs', 120000)),
    python: c.get<string>('terminal.python', '').trim(),
  };
}

/** Development checkout (../trueforge-config) first, then the copy bundled into dist/. */
function defaultConfigDir(extensionPath: string): string {
  const sibling = join(extensionPath, '..', 'trueforge-config');
  if (existsSync(join(sibling, 'agent-definition.json'))) {
    return sibling;
  }
  return join(extensionPath, 'dist', 'trueforge-config');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Repository-root .env next to trueforge-config (shared with scripts/setup-trueforge.sh). */
export function dotEnvCandidates(configDir: string): string[] {
  return [join(configDir, '..', '.env')];
}
