import * as vscode from 'vscode';
import { PREVIEW_SCHEME, type HunkManager } from './HunkManager';
import { DiffCodeLensProvider } from './DiffCodeLensProvider';
import type { UndoHistoryManager } from './UndoManager';

type Target = { editId: string; hunkId?: string } | undefined;

function asTarget(arg: unknown): Target {
  if (arg && typeof arg === 'object' && 'editId' in arg && typeof (arg as { editId: unknown }).editId === 'string') {
    return arg as Target;
  }
  return undefined;
}

/** Registers the review/undo commands and the CodeLens provider. */
export function registerReviewCommands(context: vscode.ExtensionContext, hunks: HunkManager, undo: UndoHistoryManager): void {
  const lenses = new DiffCodeLensProvider(hunks);
  context.subscriptions.push(
    lenses,
    vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: PREVIEW_SCHEME }, { scheme: 'untitled' }], lenses),
    vscode.commands.registerCommand('forgecode.acceptHunk', (arg?: unknown) => hunks.decide(asTarget(arg), 'accepted', 'hunk')),
    vscode.commands.registerCommand('forgecode.rejectHunk', (arg?: unknown) => hunks.decide(asTarget(arg), 'rejected', 'hunk')),
    vscode.commands.registerCommand('forgecode.acceptFile', (arg?: unknown) => hunks.decide(asTarget(arg), 'accepted', 'file')),
    vscode.commands.registerCommand('forgecode.rejectFile', (arg?: unknown) => hunks.decide(asTarget(arg), 'rejected', 'file')),
    vscode.commands.registerCommand('forgecode.acceptAll', () => hunks.decide(undefined, 'accepted', 'all')),
    vscode.commands.registerCommand('forgecode.rejectAll', () => hunks.decide(undefined, 'rejected', 'all')),
    vscode.commands.registerCommand('forgecode.jumpToHunk', (arg?: unknown) => {
      const target = asTarget(arg);
      return target ? hunks.jumpTo(target.editId, target.hunkId) : undefined;
    }),
    vscode.commands.registerCommand('forgecode.undoLastEdit', () => undo.undo()),
    vscode.commands.registerCommand('forgecode.redoLastEdit', () => undo.redo()),
  );
}
