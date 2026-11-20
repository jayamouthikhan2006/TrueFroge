import * as vscode from 'vscode';
import type { HunkManager } from './HunkManager';

/** Renders `[✓ Accept Hunk] [✗ Reject Hunk] [✓ Accept All in File] [✗ Reject File]` above every pending hunk. */
export class DiffCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly hunks: HunkManager) {
    this.subscription = hunks.onDidChange(() => this.emitter.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    for (const spec of this.hunks.lensesFor(document.uri)) {
      const line = Math.min(spec.line, Math.max(0, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const target = { editId: spec.editId, hunkId: spec.hunkId };
      lenses.push(
        new vscode.CodeLens(range, { title: '✓ Accept Hunk', command: 'forgecode.acceptHunk', arguments: [target], tooltip: 'Apply this hunk (Ctrl+Shift+Enter)' }),
        new vscode.CodeLens(range, { title: '✗ Reject Hunk', command: 'forgecode.rejectHunk', arguments: [target], tooltip: 'Discard this hunk (Ctrl+Shift+Backspace)' }),
        new vscode.CodeLens(range, { title: '✓ Accept All in File', command: 'forgecode.acceptFile', arguments: [{ editId: spec.editId }] }),
        new vscode.CodeLens(range, { title: '✗ Reject File', command: 'forgecode.rejectFile', arguments: [{ editId: spec.editId }] }),
        new vscode.CodeLens(range, { title: `ForgeCode hunk ${spec.index + 1}/${spec.total} · ${truncate(spec.description, 70)}`, command: '' }),
      );
    }
    return lenses;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
