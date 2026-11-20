import * as vscode from 'vscode';
import type { MentionResolver } from '../context/MentionResolver';
import { flattenSymbols } from '../context/PythonSymbolExtractor';
import type { WorkspaceIndexer } from '../context/WorkspaceIndexer';
import type { AgentRunner } from '../trueforge/AgentRunner';
import type { ForgeEventBus } from '../util/events';
import { errorMessage, type Logger } from '../util/log';
import type { WorkspaceFiles } from '../workspace/WorkspaceFiles';

const CONTEXT_LINES = 30;

/**
 * Ctrl/Cmd+Shift+I: edit the selection (or the symbol under the cursor) with
 * a TrueForge turn. The proposal comes back through propose_edit and is
 * rendered by the same per-hunk diff engine directly in this editor.
 */
export class InlineEditController implements vscode.Disposable {
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  private readonly subscription: { dispose(): void };
  private activeRunId: string | undefined;

  constructor(
    private readonly runner: AgentRunner,
    private readonly files: WorkspaceFiles,
    private readonly indexer: WorkspaceIndexer,
    private readonly mentions: MentionResolver,
    private readonly bus: ForgeEventBus,
    private readonly log: Logger,
    private readonly tokenBudget: () => number,
  ) {
    this.status.command = 'forgecode.cancelRun';
    this.status.tooltip = 'ForgeCode inline edit is running. Click or press Esc to stop.';
    // Mirror the run's progress in the status bar so the editor stays the focus.
    this.subscription = bus.on((event) => {
      if (!this.activeRunId || ('runId' in event && event.runId !== this.activeRunId)) {
        return;
      }
      if (event.type === 'tool.started') {
        this.show(`$(loading~spin) ForgeCode: ${event.name.replace(/_/g, ' ')}…`);
      } else if (event.type === 'tool.approval' && event.state === 'required') {
        this.show('$(diff) ForgeCode: review the proposed hunks');
      } else if (event.type === 'failover') {
        this.show(`$(warning) ForgeCode: primary failed (${event.reason}), using ${event.to}…`);
      } else if (event.type === 'message.delta' && !event.reasoning) {
        this.show('$(loading~spin) ForgeCode: thinking…');
      }
    });
  }

  /** `instruction` skips the input box (keybinding args, automation). */
  async run(instruction?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('ForgeCode: open a file and select code to edit inline.');
      return;
    }
    const rel = this.files.relativeOf(editor.document.uri);
    if (!rel || editor.document.uri.scheme !== 'file') {
      void vscode.window.showWarningMessage('ForgeCode: inline edit works on files inside the workspace folder.');
      return;
    }
    if (this.runner.isRunning) {
      void vscode.window.showWarningMessage('ForgeCode: a run is already in progress (Esc to stop it).');
      return;
    }

    await this.indexer.ready();
    const document = editor.document;
    const range = this.targetRange(editor, rel);
    instruction ??= await vscode.window.showInputBox({
      title: `ForgeCode Inline Edit · ${rel}:${range.start.line + 1}-${range.end.line + 1}`,
      prompt: 'Describe the change. @file:<path> and @symbol:<name> attach extra context.',
      placeHolder: 'e.g. Treat "off" and "n" as false as well, and update the docstring',
      ignoreFocusOut: true,
    });
    if (!instruction?.trim()) {
      return;
    }

    try {
      const resolution = await this.mentions.resolve(instruction, Math.floor(this.tokenBudget() / 2));
      const prompt = this.buildPrompt(document, rel, range, instruction.trim(), resolution.items);
      const explicitTokens = resolution.tokens;
      this.show('$(loading~spin) ForgeCode: sending to TrueForge…');
      editor.selection = new vscode.Selection(range.start, range.end);
      const resultPromise = this.runner.run({
        mode: 'inline',
        prompt,
        displayPrompt: instruction.trim(),
        focusPaths: [rel],
        attachedPaths: [rel, ...resolution.items.map((i) => i.path)],
        explicitTokens,
        freshSession: true,
      });
      this.activeRunId = this.runner.currentRun?.id;
      if (this.activeRunId && resolution.items.length > 0) {
        this.bus.emit({ type: 'context.explicit', runId: this.activeRunId, tokens: explicitTokens, items: resolution.items.map((i) => ({ mention: i.mention, path: i.path, startLine: i.startLine, endLine: i.endLine, tokens: i.tokens })) });
      }
      const result = await resultPromise;
      if (result.status === 'done') {
        const summary = (result.output ?? '').trim().split('\n')[0]?.slice(0, 200);
        if (summary) {
          void vscode.window.setStatusBarMessage(`ForgeCode: ${summary}`, 8000);
        }
      } else if (result.status === 'cancelled') {
        void vscode.window.setStatusBarMessage(`ForgeCode: ${result.message ?? 'cancelled'}`, 6000);
      }
    } catch (error) {
      this.log.error('inline edit failed', error);
      void vscode.window.showErrorMessage(`ForgeCode inline edit failed: ${errorMessage(error)}`);
    } finally {
      this.activeRunId = undefined;
      this.status.hide();
    }
  }

  /** The selection, or the innermost symbol around the cursor, or the current line. */
  private targetRange(editor: vscode.TextEditor, rel: string): vscode.Range {
    const selection = editor.selection;
    if (!selection.isEmpty) {
      const endLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line - 1 : selection.end.line;
      return new vscode.Range(selection.start.line, 0, endLine, editor.document.lineAt(endLine).text.length);
    }
    const line = selection.active.line + 1;
    const file = this.indexer.index.getFile(rel);
    const enclosing = file
      ? flattenSymbols(file.symbols)
          .filter((s) => s.kind !== 'variable' && s.startLine <= line && s.endLine >= line)
          .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0]
      : undefined;
    if (enclosing) {
      return new vscode.Range(enclosing.startLine - 1, 0, enclosing.endLine - 1, editor.document.lineAt(enclosing.endLine - 1).text.length);
    }
    return editor.document.lineAt(selection.active.line).range;
  }

  private buildPrompt(document: vscode.TextDocument, rel: string, range: vscode.Range, instruction: string, mentions: Array<{ mention: string; path: string; startLine: number; endLine: number; text: string }>): string {
    const lang = document.languageId;
    const start = range.start.line;
    const end = range.end.line;
    const lines = (from: number, to: number) => {
      const out: string[] = [];
      for (let i = Math.max(0, from); i <= Math.min(document.lineCount - 1, to); i++) {
        out.push(document.lineAt(i).text);
      }
      return out.join('\n');
    };
    const beforeFrom = Math.max(0, start - CONTEXT_LINES);
    const afterTo = Math.min(document.lineCount - 1, end + CONTEXT_LINES);
    const file = this.indexer.index.getFile(rel);
    const outline = file
      ? flattenSymbols(file.symbols)
          .filter((s) => s.kind !== 'variable' || s.indent === 0)
          .map((s) => `- ${s.kind} ${s.qualifiedName} L${s.startLine}-${s.endLine}`)
          .slice(0, 80)
          .join('\n')
      : '(outline unavailable)';
    const parts = [
      '[INLINE EDIT]',
      `File: ${rel} (${lang}, ${document.lineCount} lines)`,
      `Selected lines: ${start + 1}-${end + 1}`,
      `Instruction: ${instruction}`,
      '',
      `Selected code (L${start + 1}-${end + 1}):`,
      `\`\`\`${lang}\n${lines(start, end)}\n\`\`\``,
    ];
    if (start > beforeFrom) {
      parts.push(`Context before (L${beforeFrom + 1}-${start}):`, `\`\`\`${lang}\n${lines(beforeFrom, start - 1)}\n\`\`\``);
    }
    if (afterTo > end) {
      parts.push(`Context after (L${end + 2}-${afterTo + 1}):`, `\`\`\`${lang}\n${lines(end + 1, afterTo)}\n\`\`\``);
    }
    parts.push('File outline:', outline);
    for (const m of mentions) {
      parts.push(`Attached ${m.mention} (${m.path} L${m.startLine}-${m.endLine}):`, `\`\`\`\n${m.text}\n\`\`\``);
    }
    parts.push('', `Make exactly one propose_edit call for ${rel}. The old_string values must match the file text above exactly.`);
    return parts.join('\n');
  }

  private show(text: string): void {
    this.status.text = text;
    this.status.show();
  }

  dispose(): void {
    this.subscription.dispose();
    this.status.dispose();
  }
}
