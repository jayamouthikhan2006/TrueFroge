import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';

/**
 * Workspace-relative file access shared by the MCP tools, the index and the
 * edit engine. Paths are always forward-slash and relative to the root
 * folder; anything that escapes the root is rejected.
 *
 * Reads honour an overlay: while a file is under per-hunk review its editor
 * buffer shows a merged preview (old and new lines side by side), so the
 * agent and the index must see the file's logical content instead.
 */
export class WorkspaceFiles {
  private overlay: ((relPath: string) => string | undefined) | undefined;

  constructor(readonly root: vscode.Uri) {}

  static fromWorkspace(): WorkspaceFiles | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? new WorkspaceFiles(folder.uri) : undefined;
  }

  get rootPath(): string {
    return this.root.fsPath;
  }

  setOverlay(overlay: (relPath: string) => string | undefined): void {
    this.overlay = overlay;
  }

  /** Normalizes a user/agent supplied path to a safe workspace-relative path. */
  toRelative(input: string): string {
    const cleaned = input.trim().replace(/^["'`]|["'`]$/g, '').replace(/\\/g, '/');
    if (cleaned.length === 0) {
      throw new Error('path is empty');
    }
    const absolute = isAbsolute(cleaned) || /^[A-Za-z]:\//.test(cleaned) ? resolve(cleaned) : resolve(this.rootPath, cleaned);
    const rel = relative(this.rootPath, absolute).split(sep).join('/');
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`path ${input} is outside the workspace`);
    }
    return posix.normalize(rel === '' ? '.' : rel);
  }

  uri(relPath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...this.toRelative(relPath).split('/').filter((s) => s !== '.'));
  }

  relativeOf(uri: vscode.Uri): string | undefined {
    const rel = relative(this.rootPath, uri.fsPath).split(sep).join('/');
    return rel.startsWith('..') || isAbsolute(rel) ? undefined : rel;
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(this.uri(relPath));
      return true;
    } catch {
      return false;
    }
  }

  /** Logical content: review overlay, else open (possibly unsaved) document, else disk. `null` if missing. */
  async read(relPath: string): Promise<string | null> {
    const rel = this.toRelative(relPath);
    const overlaid = this.overlay?.(rel);
    if (overlaid !== undefined) {
      return overlaid;
    }
    const uri = this.uri(rel);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
      return open.getText();
    }
    return this.readDisk(rel);
  }

  async readDisk(relPath: string): Promise<string | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.uri(relPath));
      return new TextDecoder('utf-8').decode(bytes);
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        return null;
      }
      if ((error as { code?: string }).code === 'FileNotFound' || (error as { code?: string }).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}
