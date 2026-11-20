import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { InlineEditController } from './commands/InlineEditController';
import { dotEnvCandidates, type ForgeSettings, readSettings } from './config';
import { ContextEngine } from './context/ContextEngine';
import { MentionResolver } from './context/MentionResolver';
import { WorkspaceIndexer } from './context/WorkspaceIndexer';
import { HunkManager } from './diff/HunkManager';
import { PendingEditStore } from './diff/PendingEditStore';
import { registerReviewCommands } from './diff/reviewCommands';
import { UndoHistoryManager } from './diff/UndoManager';
import { MCP_SERVER_NAME, WorkspaceMcpServer } from './mcp/WorkspaceMcpServer';
import { CommandRunner } from './terminal/CommandRunner';
import { AgentRunner } from './trueforge/AgentRunner';
import { ApprovalBroker } from './trueforge/ApprovalBroker';
import { loadEnv } from './trueforge/provisioning/env';
import { type ForgeConfig, loadForgeConfig } from './trueforge/provisioning/ForgeConfig';
import { Provisioner } from './trueforge/provisioning/Provisioner';
import { TrueForgeRest } from './trueforge/rest';
import { TrueForgeClient } from './trueforge/TrueForgeClient';
import { ForgeEventBus } from './util/events';
import { errorMessage, type Logger, SinkLogger } from './util/log';
import { AgentPanelProvider } from './webview/AgentPanelProvider';
import { WorkspaceFiles } from './workspace/WorkspaceFiles';

const TOKEN_KEY = 'forgecode.mcpToken';
const HEALTH_INTERVAL_MS = 10_000;

export async function activate(context: vscode.ExtensionContext): Promise<ForgeCodeApi | undefined> {
  const output = vscode.window.createOutputChannel('ForgeCode');
  context.subscriptions.push(output);
  const log = new SinkLogger(output, true);

  const files = WorkspaceFiles.fromWorkspace();
  if (!files) {
    const needFolder = () => void vscode.window.showWarningMessage('ForgeCode: open a folder (e.g. the flask checkout) to use the agent.');
    for (const id of ['forgecode.inlineEdit', 'forgecode.openAgent', 'forgecode.provision']) {
      context.subscriptions.push(vscode.commands.registerCommand(id, needFolder));
    }
    log.warn('no workspace folder open; ForgeCode is idle');
    return;
  }

  let settings: ForgeSettings = readSettings(context.extensionPath);
  const env = () => loadEnv(dotEnvCandidates(settings.configDir));
  let forgeConfig: ForgeConfig | undefined;
  const loadConfig = () => {
    try {
      forgeConfig = loadForgeConfig(settings.configDir, env());
    } catch (error) {
      forgeConfig = undefined;
      log.warn(`trueforge-config could not be loaded from ${settings.configDir}: ${errorMessage(error)}`);
    }
  };
  loadConfig();

  // ---- core services ----------------------------------------------------------
  const bus = new ForgeEventBus();
  const store = new PendingEditStore(files);
  let hunks: HunkManager | undefined;
  const undo = new UndoHistoryManager(files, bus, log, (rel) => hunks?.isUnderReview(rel) ?? false);
  hunks = new HunkManager(store, files, undo, bus, log);
  const indexer = new WorkspaceIndexer(files, settings.maxIndexedFiles, log);
  const engine = new ContextEngine(indexer.index);
  const mentions = new MentionResolver(files, indexer.index);
  const broker = new ApprovalBroker();
  context.subscriptions.push(hunks, indexer, broker);
  registerReviewCommands(context, hunks, undo);
  void indexer.ready();

  let client: TrueForgeClient | undefined;
  const getClient = () => {
    if (!client || client.baseUrl !== settings.trueforgeBaseUrl) {
      client = new TrueForgeClient({ baseUrl: settings.trueforgeBaseUrl, apiKey: settings.trueforgeApiKey || undefined });
    }
    return client;
  };
  const commandRunner = () => new CommandRunner({ root: files.rootPath, allowedPrefixes: settings.allowedCommands, timeoutMs: settings.terminalTimeoutMs, python: settings.python });

  // ---- MCP server ---------------------------------------------------------------
  const token = settings.mcpAuthToken || env().FORGECODE_MCP_TOKEN || context.globalState.get<string>(TOKEN_KEY) || randomBytes(24).toString('hex');
  if (!settings.mcpAuthToken && !env().FORGECODE_MCP_TOKEN) {
    await context.globalState.update(TOKEN_KEY, token);
  }
  let runner: AgentRunner | undefined;
  const mcpDeps = {
    files,
    indexer,
    engine,
    store,
    runner: commandRunner,
    skills: () => forgeConfig?.skills ?? [],
    tokenBudget: () => settings.tokenBudget,
    runContext: () => runner?.runContext(),
    bus,
    log,
  };
  const mcp = await startMcpServer(mcpDeps, settings, token, log);
  if (mcp) {
    context.subscriptions.push(mcp);
  }

  // ---- provisioning -------------------------------------------------------------
  let provisioned = false;
  const provision = async (full: boolean): Promise<void> => {
    loadConfig();
    if (!forgeConfig) {
      throw new Error(`trueforge-config not found at ${settings.configDir}`);
    }
    if (!mcp) {
      throw new Error('the workspace MCP server is not running');
    }
    const provisioner = new Provisioner(new TrueForgeRest({ baseUrl: settings.trueforgeBaseUrl, apiKey: settings.trueforgeApiKey || undefined }), log);
    const exists = (await provisioner.findAgent(settings.agentName)) !== undefined;
    const report = await provisioner.provision(forgeConfig, {
      mcp: { url: mcp.url, bearerToken: token },
      registerProviders: full,
      registerAgent: full || !exists,
      primaryModel: settings.primaryModel || undefined,
    });
    provisioned = true;
    runner?.invalidateAgent();
    log.info(`provisioned: MCP ${report.mcpServers.join(', ')}; agent ${report.agent ? `${report.agent.name} on ${report.agent.model}` : 'unchanged'}`);
  };

  // ---- runner, UI -----------------------------------------------------------------
  runner = new AgentRunner({
    client: getClient,
    settings: () => settings,
    catalogModels: () => forgeConfig?.models ?? {},
    provision: () => provision(false),
    store,
    broker,
    checkCommand: (command) => void commandRunner().check(command),
    workspaceRoot: files.rootPath,
    bus,
    log,
  });
  context.subscriptions.push(runner);

  let trueforgeHealth: 'up' | 'down' | 'unknown' = 'unknown';
  const panel = new AgentPanelProvider(context.extensionUri, {
    runner,
    hunks,
    undo,
    broker,
    mentions,
    indexer,
    files,
    bus,
    log,
    tokenBudget: () => settings.tokenBudget,
    availableModels: () => getClient().listModels(),
    health: () => ({ trueforge: trueforgeHealth, trueforgeUrl: settings.trueforgeBaseUrl, mcpUrl: mcp?.url ?? 'not running', mcpSessions: mcp?.stats.sessions ?? 0, indexFiles: indexer.index.fileCount }),
    sessionUrl: (id) => getClient().sessionUrl(id),
  });
  context.subscriptions.push(panel, vscode.window.registerWebviewViewProvider(AgentPanelProvider.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }));

  const inline = new InlineEditController(runner, files, indexer, mentions, bus, log, () => settings.tokenBudget);
  context.subscriptions.push(inline);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'forgecode.switchModel';
  context.subscriptions.push(status);
  const renderStatus = () => {
    const models = runner!.models();
    if (runner!.isRunning) {
      status.text = `$(loading~spin) ForgeCode · ${runner!.currentRun?.model ?? models.primary ?? ''}`;
      status.tooltip = 'ForgeCode is running. Esc or "ForgeCode: Stop Generation" to cancel.';
    } else if (trueforgeHealth === 'down') {
      status.text = '$(warning) ForgeCode: TrueForge offline';
      status.tooltip = `TrueForge is not reachable at ${settings.trueforgeBaseUrl}. Run scripts/setup-trueforge.sh.`;
    } else {
      status.text = `$(flame) ForgeCode · ${models.primary ?? 'no model'}`;
      status.tooltip = `Primary: ${models.primary ?? '—'}\nFallback: ${models.fallback ?? 'none'}\nMCP: ${mcp?.url ?? 'not running'}\nClick to switch model.`;
    }
    status.show();
  };
  context.subscriptions.push({ dispose: bus.on((event) => (event.type === 'run.started' || event.type === 'run.finished' || event.type === 'failover' ? renderStatus() : undefined)).dispose });
  renderStatus();

  const checkHealth = async () => {
    const before = trueforgeHealth;
    try {
      await getClient().ping();
      trueforgeHealth = 'up';
      if (!provisioned && settings.autoProvision) {
        await provision(false).catch((error) => log.warn(`auto-provisioning failed: ${errorMessage(error)}`));
      }
    } catch {
      trueforgeHealth = 'down';
      provisioned = false;
    }
    if (before !== trueforgeHealth) {
      log.info(`TrueForge at ${settings.trueforgeBaseUrl} is ${trueforgeHealth}`);
      renderStatus();
    }
  };
  void checkHealth();
  const healthTimer = setInterval(() => void checkHealth(), HEALTH_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(healthTimer) });

  // ---- commands -----------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('forgecode.inlineEdit', (instruction?: unknown) => inline.run(typeof instruction === 'string' ? instruction : undefined)),
    vscode.commands.registerCommand('forgecode.openAgent', () => panel.reveal()),
    vscode.commands.registerCommand('forgecode.cancelRun', () => runner!.cancel()),
    vscode.commands.registerCommand('forgecode.switchModel', async () => {
      const available = await getClient()
        .listModels()
        .catch(() => [] as string[]);
      const models = runner!.models();
      const picks: Array<vscode.QuickPickItem & { value: string | undefined }> = [
        { label: '$(settings) Use configured primary', description: settings.primaryModel || forgeConfig?.models.primary || '', value: undefined },
        ...available.map((name) => ({ label: name, description: name === models.fallback ? 'fallback' : name === models.primary ? 'current primary' : '', value: name })),
      ];
      const choice = await vscode.window.showQuickPick(picks, { title: 'ForgeCode: model for the next runs (TrueForge model catalog)', placeHolder: `Fallback on failure: ${models.fallback ?? 'none'}` });
      if (choice) {
        runner!.setModelOverride(choice.value);
        renderStatus();
      }
    }),
    vscode.commands.registerCommand('forgecode.provision', async () => {
      try {
        await provision(true);
        void vscode.window.showInformationMessage(`ForgeCode: registered models, ${MCP_SERVER_NAME} (${mcp?.url}) and ${settings.agentName} with TrueForge.`);
      } catch (error) {
        log.error('provisioning failed', error);
        void vscode.window.showErrorMessage(`ForgeCode: provisioning failed: ${errorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand('forgecode.openSessionInTrueForge', async () => {
      const id = runner!.currentRun?.sessionId ?? runner!.conversationSessionId;
      if (!id) {
        void vscode.window.showInformationMessage('ForgeCode: no TrueForge session yet.');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(getClient().sessionUrl(id)));
    }),
    vscode.commands.registerCommand('forgecode.showContextManifest', async () => {
      const manifest = engine.lastManifest;
      if (!manifest) {
        void vscode.window.showInformationMessage('ForgeCode: no retrieval has run yet.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(manifest, null, 2) });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand('forgecode.rebuildIndex', async () => {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'ForgeCode: indexing workspace' }, () => indexer.rebuild());
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('forgecode')) {
        settings = readSettings(context.extensionPath);
        loadConfig();
        runner!.invalidateAgent();
        renderStatus();
      }
    }),
  );

  log.info(`ForgeCode active for ${files.rootPath}; TrueForge ${settings.trueforgeBaseUrl}; MCP ${mcp?.url ?? 'not running'}`);
  return { bus, runner, hunks, undo, store, engine, indexer, broker, mcpUrl: mcp?.url, provision };
}

/** Returned from activate() for other extensions and integration tests. */
export interface ForgeCodeApi {
  bus: ForgeEventBus;
  runner: AgentRunner;
  hunks: HunkManager;
  undo: UndoHistoryManager;
  store: PendingEditStore;
  engine: ContextEngine;
  indexer: WorkspaceIndexer;
  broker: ApprovalBroker;
  mcpUrl: string | undefined;
  provision: (full: boolean) => Promise<void>;
}

async function startMcpServer(deps: ConstructorParameters<typeof WorkspaceMcpServer>[0], settings: ForgeSettings, token: string, log: Logger): Promise<WorkspaceMcpServer | undefined> {
  for (let port = settings.mcpPort; port < settings.mcpPort + 10; port++) {
    const server = new WorkspaceMcpServer(deps, { host: settings.mcpHost, port, token });
    try {
      await server.start();
      if (port !== settings.mcpPort) {
        log.warn(`port ${settings.mcpPort} was busy; MCP server is on ${port} (TrueForge registration uses the live port)`);
      }
      return server;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        log.error('MCP server failed to start', error);
        void vscode.window.showErrorMessage(`ForgeCode: MCP server failed to start: ${errorMessage(error)}`);
        return undefined;
      }
    }
  }
  void vscode.window.showErrorMessage(`ForgeCode: ports ${settings.mcpPort}-${settings.mcpPort + 9} are all in use; the MCP server is not running.`);
  return undefined;
}

export function deactivate(): void {}
