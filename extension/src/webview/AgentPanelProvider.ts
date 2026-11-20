import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ContextManifest } from '../context/ContextEngine';
import type { MentionResolver } from '../context/MentionResolver';
import type { WorkspaceIndexer } from '../context/WorkspaceIndexer';
import type { HunkManager } from '../diff/HunkManager';
import type { UndoHistoryManager } from '../diff/UndoManager';
import type { AgentRunner } from '../trueforge/AgentRunner';
import type { ApprovalBroker } from '../trueforge/ApprovalBroker';
import type { ForgeEvent, ForgeEventBus } from '../util/events';
import { errorMessage, type Logger } from '../util/log';
import type { WorkspaceFiles } from '../workspace/WorkspaceFiles';

export interface PanelHealth {
  trueforge: 'up' | 'down' | 'unknown';
  trueforgeUrl: string;
  mcpUrl: string;
  mcpSessions: number;
  indexFiles: number;
}

export interface PanelDependencies {
  runner: AgentRunner;
  hunks: HunkManager;
  undo: UndoHistoryManager;
  broker: ApprovalBroker;
  mentions: MentionResolver;
  indexer: WorkspaceIndexer;
  files: WorkspaceFiles;
  bus: ForgeEventBus;
  log: Logger;
  tokenBudget: () => number;
  availableModels: () => Promise<string[]>;
  health: () => PanelHealth;
  sessionUrl: (sessionId: string) => string;
}

type InboundMessage =
  | { type: 'ready' }
  | { type: 'submit'; text: string }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'hunk'; action: 'accept' | 'reject'; editId: string; hunkId?: string }
  | { type: 'file'; action: 'accept' | 'reject'; editId: string }
  | { type: 'all'; action: 'accept' | 'reject' }
  | { type: 'jump'; editId: string; hunkId?: string }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'approval'; id: string; allow: boolean }
  | { type: 'answer'; id: string; text: string }
  | { type: 'suggest'; kind: 'file' | 'symbol'; query: string; requestId: number }
  | { type: 'setModel'; model: string }
  | { type: 'openSession' }
  | { type: 'refreshModels' };

/** The "ForgeCode Agent" sidebar: streaming transcript, tool trace, context budget meter, hunk cards, approvals. */
export class AgentPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'forgecode.agentView';
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly backlog: ForgeEvent[] = [];
  private lastManifest: ContextManifest | undefined;
  private models: string[] = [];
  private selectedModel = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: PanelDependencies,
  ) {
    this.disposables.push(
      deps.bus.on((event) => this.onEvent(event)),
      deps.hunks.onDidChange(() => this.pushState()),
      deps.broker.onDidChange(() => this.pushState()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    this.disposables.push(
      view.webview.onDidReceiveMessage((message: InboundMessage) => {
        void this.onMessage(message).catch((error) => {
          this.deps.log.error('panel action failed', error);
          void vscode.window.showErrorMessage(`ForgeCode: ${errorMessage(error)}`);
        });
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.pushState();
        }
      }),
    );
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${AgentPanelProvider.viewId}.focus`);
  }

  private onEvent(event: ForgeEvent): void {
    if (event.type === 'context.manifest') {
      this.lastManifest = event.manifest;
    }
    if (event.type === 'undo.changed' || event.type === 'edits.changed') {
      this.pushState();
      return;
    }
    if (!this.view) {
      // Keep a bounded backlog so a panel opened mid-run catches up.
      this.backlog.push(event);
      if (this.backlog.length > 2000) {
        this.backlog.splice(0, this.backlog.length - 2000);
      }
      return;
    }
    void this.view.webview.postMessage({ type: 'event', event });
    if (event.type === 'run.started' || event.type === 'run.finished' || event.type === 'run.session' || event.type === 'failover') {
      this.pushState();
    }
  }

  private async onMessage(message: InboundMessage): Promise<void> {
    const { deps } = this;
    switch (message.type) {
      case 'ready':
        for (const event of this.backlog.splice(0)) {
          void this.view?.webview.postMessage({ type: 'event', event });
        }
        await this.refreshModels();
        this.pushState();
        break;
      case 'submit':
        await this.submit(message.text);
        break;
      case 'stop':
        await deps.runner.cancel();
        break;
      case 'newChat':
        if (deps.runner.isRunning) {
          void vscode.window.showWarningMessage('ForgeCode: stop the current run before starting a new chat.');
          return;
        }
        deps.runner.resetConversation();
        void this.view?.webview.postMessage({ type: 'cleared' });
        this.pushState();
        break;
      case 'undo':
        await deps.undo.undo();
        break;
      case 'redo':
        await deps.undo.redo();
        break;
      case 'hunk':
        await deps.hunks.decide({ editId: message.editId, hunkId: message.hunkId }, message.action === 'accept' ? 'accepted' : 'rejected', 'hunk');
        break;
      case 'file':
        await deps.hunks.decide({ editId: message.editId }, message.action === 'accept' ? 'accepted' : 'rejected', 'file');
        break;
      case 'all':
        await deps.hunks.decide(undefined, message.action === 'accept' ? 'accepted' : 'rejected', 'all');
        break;
      case 'jump':
        await deps.hunks.jumpTo(message.editId, message.hunkId);
        break;
      case 'openFile': {
        const uri = deps.files.uri(message.path);
        const editor = await vscode.window.showTextDocument(uri, { preview: true });
        if (message.line) {
          const pos = new vscode.Position(Math.max(0, message.line - 1), 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
        break;
      }
      case 'approval':
        deps.broker.answer(message.id, message.allow ? { allow: true } : { allow: false, reason: 'The user denied this action in the ForgeCode panel.' });
        break;
      case 'answer':
        deps.broker.answer(message.id, { allow: true, text: message.text });
        break;
      case 'suggest': {
        await deps.indexer.ready();
        const items = deps.mentions.suggest(message.kind, message.query);
        void this.view?.webview.postMessage({ type: 'suggestions', requestId: message.requestId, items });
        break;
      }
      case 'setModel':
        this.selectedModel = message.model;
        deps.runner.setModelOverride(message.model || undefined);
        this.pushState();
        break;
      case 'openSession': {
        const id = deps.runner.currentRun?.sessionId ?? deps.runner.conversationSessionId;
        if (id) {
          await vscode.env.openExternal(vscode.Uri.parse(deps.sessionUrl(id)));
        }
        break;
      }
      case 'refreshModels':
        await this.refreshModels();
        this.pushState();
        break;
    }
  }

  private async submit(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) {
      return;
    }
    const { deps } = this;
    if (deps.runner.isRunning) {
      void vscode.window.showWarningMessage('ForgeCode: a run is already in progress.');
      return;
    }
    await deps.indexer.ready();
    const budget = deps.tokenBudget();
    const resolution = await deps.mentions.resolve(text, Math.floor(budget / 2));
    if (resolution.unresolved.length > 0) {
      void vscode.window.showWarningMessage(`ForgeCode: could not resolve ${resolution.unresolved.join(', ')}`);
    }
    let prompt = text;
    if (resolution.items.length > 0) {
      const attached = resolution.items
        .map((item) => `### ${item.mention} → ${item.path} L${item.startLine}-${item.endLine}${item.truncated ? ' (truncated)' : ''}\n\`\`\`\n${item.text}\n\`\`\``)
        .join('\n\n');
      prompt = `${text}\n\n[Context attached explicitly by the user (${resolution.tokens} tokens). Use retrieve_context for anything else.]\n\n${attached}`;
    }
    const run = deps.runner.run({
      mode: 'agent',
      prompt,
      displayPrompt: text,
      focusPaths: resolution.items.map((i) => i.path),
      attachedPaths: resolution.items.map((i) => i.path),
      explicitTokens: resolution.tokens,
    });
    const runId = deps.runner.currentRun?.id;
    if (runId) {
      deps.bus.emit({
        type: 'context.explicit',
        runId,
        tokens: resolution.tokens,
        items: resolution.items.map((i) => ({ mention: i.mention, path: i.path, startLine: i.startLine, endLine: i.endLine, tokens: i.tokens })),
      });
    }
    await run;
  }

  private async refreshModels(): Promise<void> {
    try {
      this.models = await this.deps.availableModels();
    } catch {
      this.models = [];
    }
  }

  private pushState(): void {
    if (!this.view) {
      return;
    }
    const { deps } = this;
    const configured = deps.runner.models();
    const run = deps.runner.currentRun;
    const sessionId = run?.sessionId ?? deps.runner.conversationSessionId;
    void this.view.webview.postMessage({
      type: 'state',
      state: {
        running: deps.runner.isRunning,
        mode: run?.mode,
        activeModel: run?.model,
        models: { primary: configured.primary, fallback: configured.fallback, available: this.models, selected: this.selectedModel },
        session: sessionId ? { id: sessionId, url: deps.sessionUrl(sessionId), turnId: run?.turnId } : undefined,
        reviews: deps.hunks.snapshot(),
        approvals: deps.broker.pending(),
        undo: { canUndo: deps.undo.canUndo, canRedo: deps.undo.canRedo, label: deps.undo.peek()?.label },
        budget: deps.tokenBudget(),
        manifest: this.lastManifest,
        health: deps.health(),
      },
    });
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const csp = [`default-src 'none'`, `style-src ${webview.cspSource}`, `script-src 'nonce-${nonce}'`, `img-src ${webview.cspSource} data:`, `font-src ${webview.cspSource}`].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style}">
<title>ForgeCode Agent</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
