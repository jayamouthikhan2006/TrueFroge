import { diffArrays } from 'diff';
import * as vscode from 'vscode';

/**
 * Saves a document without running save participants (format-on-save,
 * trim-trailing-whitespace, organize imports), so the bytes on disk are exactly
 * the reviewed content and git diffs contain only the accepted hunks.
 */
export async function saveExactly(document: vscode.TextDocument): Promise<void> {
  if (!document.isDirty) {
    return;
  }
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  if (editor.document.uri.toString() === document.uri.toString()) {
    await vscode.commands.executeCommand('workbench.action.files.saveWithoutFormatting');
  }
  if (document.isDirty) {
    // Fallback when the command could not target this editor.
    await document.save();
  }
}

/** Discards unsaved buffer changes by reloading from disk (no disk write). */
export async function revertDocument(document: vscode.TextDocument): Promise<void> {
  if (!document.isDirty) {
    return;
  }
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  if (editor.document.uri.toString() === document.uri.toString()) {
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
}

export function documentLines(document: vscode.TextDocument): string[] {
  const lines: string[] = [];
  for (let i = 0; i < document.lineCount; i++) {
    lines.push(document.lineAt(i).text);
  }
  return lines;
}

/**
 * Turns `document` into `target` (an array of lines, the same shape as
 * `text.split('\n')`) using only the line regions that differ, so unchanged
 * lines (and the viewport, cursor and folding) are left alone. Returns false
 * when the document already matches.
 */
export async function setDocumentLines(document: vscode.TextDocument, target: string[]): Promise<boolean> {
  const current = documentLines(document);
  const changes = diffArrays(current, target);
  const edit = new vscode.WorkspaceEdit();
  let line = 0;
  let changed = false;
  let i = 0;
  while (i < changes.length) {
    const change = changes[i]!;
    if (!change.added && !change.removed) {
      line += change.value.length;
      i++;
      continue;
    }
    // Merge an adjacent removed+added pair into one region.
    let removed: string[] = [];
    let added: string[] = [];
    while (i < changes.length && (changes[i]!.added || changes[i]!.removed)) {
      if (changes[i]!.removed) {
        removed = removed.concat(changes[i]!.value);
      } else {
        added = added.concat(changes[i]!.value);
      }
      i++;
    }
    replaceLines(document, edit, line, line + removed.length, added);
    line += removed.length;
    changed = true;
  }
  if (!changed) {
    return false;
  }
  return vscode.workspace.applyEdit(edit);
}

function replaceLines(document: vscode.TextDocument, edit: vscode.WorkspaceEdit, start: number, end: number, added: string[]): void {
  const count = document.lineCount;
  const docEnd = document.lineAt(count - 1).range.end;
  if (end < count) {
    edit.replace(document.uri, new vscode.Range(start, 0, end, 0), added.map((l) => `${l}\n`).join(''));
    return;
  }
  // The region reaches the end of the document.
  if (added.length > 0) {
    if (start < count) {
      edit.replace(document.uri, new vscode.Range(new vscode.Position(start, 0), docEnd), added.join('\n'));
    } else {
      edit.insert(document.uri, docEnd, `\n${added.join('\n')}`);
    }
    return;
  }
  if (start > 0) {
    edit.delete(document.uri, new vscode.Range(document.lineAt(start - 1).range.end, docEnd));
  } else {
    edit.delete(document.uri, new vscode.Range(new vscode.Position(0, 0), docEnd));
  }
}
