import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ForgeEventBus } from '../util/events';
import type { Logger } from '../util/log';
import { revertDocument, saveExactly, setDocumentLines } from '../workspace/documents';
import type { WorkspaceFiles } from '../workspace/WorkspaceFiles';

export interface UndoEntry {
  id: string;
  uri: vscode.Uri;
  path: string;
  /** Disk content before the agent edit; null when the edit created the file. */
  previousContent: string | null;
  /** Disk content the agent edit produced. */
  newContent: string;
  timestamp: number;
  turnId?: string;
  runId?: string;
  label: string;
}

/**
 * Snapshot-based history of agent writes. Every write performed by the hunk
 * engine is preceded by `record()`, so `undo()` restores the exact previous
 * bytes (or deletes a file the agent created) and `redo()` re-applies them.
 */
export class UndoHistoryManager {
  private readonly undoStack: UndoEntry[] = [];
  private readonly redoStack: UndoEntry[] = [];
  private static readonly LIMIT = 100;

  constructor(
    private readonly files: WorkspaceFiles,
    private readonly bus: ForgeEventBus,
    private readonly log: Logger,
    /** Returns true when the path currently has a review in progress. */
    private readonly isUnderReview: (relPath: string) => boolean,
  ) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  peek(): UndoEntry | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  history(): UndoEntry[] {
    return [...this.undoStack].reverse();
  }

  record(entry: Omit<UndoEntry, 'id' | 'timestamp'>): UndoEntry {
    const full: UndoEntry = { ...entry, id: randomUUID(), timestamp: Date.now() };
    this.undoStack.push(full);
    if (this.undoStack.length > UndoHistoryManager.LIMIT) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
    this.changed();
    return full;
  }

  async undo(): Promise<UndoEntry | undefined> {
    const entry = this.undoStack[this.undoStack.length - 1];
    if (!entry) {
      void vscode.window.showInformationMessage('ForgeCode: no agent edit to undo.');
      return undefined;
    }
    if (!(await this.confirmIfDiverged(entry, entry.newContent, 'undo'))) {
      return undefined;
    }
    await this.writeContent(entry, entry.previousContent);
    this.undoStack.pop();
    this.redoStack.push(entry);
    this.log.info(`undo: restored ${entry.path} (${entry.label})`);
    this.changed();
    return entry;
  }

  async redo(): Promise<UndoEntry | undefined> {
    const entry = this.redoStack[this.redoStack.length - 1];
    if (!entry) {
      void vscode.window.showInformationMessage('ForgeCode: nothing to redo.');
      return undefined;
    }
    if (!(await this.confirmIfDiverged(entry, entry.previousContent, 'redo'))) {
      return undefined;
    }
    await this.writeContent(entry, entry.newContent);
    this.redoStack.pop();
    this.undoStack.push(entry);
    this.log.info(`redo: re-applied ${entry.path} (${entry.label})`);
    this.changed();
    return entry;
  }

  /** If the file changed since the snapshot, overwriting it would lose work: ask first. */
  private async confirmIfDiverged(entry: UndoEntry, expected: string | null, action: 'undo' | 'redo'): Promise<boolean> {
    if (this.isUnderReview(entry.path)) {
      void vscode.window.showWarningMessage(`ForgeCode: finish reviewing ${entry.path} before ${action === 'undo' ? 'undoing' : 'redoing'}.`);
      return false;
    }
    const current = await this.files.read(entry.path);
    const same = (current === null && expected === null) || (current !== null && expected !== null && normalize(current) === normalize(expected));
    if (same) {
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      `${entry.path} changed after the agent edit. ${action === 'undo' ? 'Undo' : 'Redo'} anyway and overwrite those changes?`,
      { modal: true },
      'Overwrite',
    );
    return choice === 'Overwrite';
  }

  private async writeContent(entry: UndoEntry, content: string | null): Promise<void> {
    const uri = entry.uri;
    if (content === null) {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (open?.isDirty) {
        await revertDocument(open);
      }
      await vscode.workspace.fs.delete(uri, { useTrash: true });
      return;
    }
    const exists = await this.files.exists(entry.path);
    if (!exists) {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
      await vscode.window.showTextDocument(uri, { preview: false });
      return;
    }
    // Write through the editor buffer so open editors update in place and the
    // change is saved byte-exact (no format-on-save).
    const document = await vscode.workspace.openTextDocument(uri);
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    await setDocumentLines(document, normalize(content).split('\n'));
    if (document.isDirty) {
      await saveExactly(document);
    }
    const written = await this.files.readDisk(entry.path);
    if (written !== null && normalize(written) !== normalize(content)) {
      this.log.warn(`write verification mismatch for ${entry.path} (eol ${JSON.stringify(eol)})`);
    }
  }

  private changed(): void {
    this.bus.emit({ type: 'undo.changed', canUndo: this.canUndo, canRedo: this.canRedo, label: this.peek()?.label });
    void vscode.commands.executeCommand('setContext', 'forgecode.canUndo', this.canUndo);
  }
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
