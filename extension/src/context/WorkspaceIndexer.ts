import * as vscode from 'vscode';
import type { Logger } from '../util/log';
import type { WorkspaceFiles } from '../workspace/WorkspaceFiles';
import { EXCLUDED_DIRS, isIndexable, MAX_FILE_BYTES, WorkspaceIndex } from './WorkspaceIndex';

/** Keeps a WorkspaceIndex in sync with the workspace folder. */
export class WorkspaceIndexer implements vscode.Disposable {
  readonly index = new WorkspaceIndex();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private building: Promise<void> | undefined;

  constructor(
    private readonly files: WorkspaceFiles,
    private readonly maxFiles: number,
    private readonly log: Logger,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(files.root, '**/*'));
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => this.schedule(uri)),
      watcher.onDidChange((uri) => this.schedule(uri)),
      watcher.onDidDelete((uri) => {
        const rel = files.relativeOf(uri);
        if (rel) {
          this.index.remove(rel);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => this.schedule(doc.uri)),
    );
  }

  /** Builds the index once; concurrent callers share the same build. */
  ready(): Promise<void> {
    this.building ??= this.rebuild();
    return this.building;
  }

  async rebuild(): Promise<void> {
    const started = Date.now();
    const exclude = `{${EXCLUDED_DIRS.map((d) => `**/${d}/**`).join(',')},**/*.egg-info/**}`;
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.files.root, '**/*'), exclude, this.maxFiles * 4);
    const candidates = uris
      .map((uri) => ({ uri, rel: this.files.relativeOf(uri) }))
      .filter((c): c is { uri: vscode.Uri; rel: string } => c.rel !== undefined && isIndexable(c.rel))
      .slice(0, this.maxFiles);
    this.index.clear();
    const batch = 32;
    for (let i = 0; i < candidates.length; i += batch) {
      await Promise.all(candidates.slice(i, i + batch).map((c) => this.indexOne(c.uri, c.rel)));
    }
    this.log.info(`context index built: ${this.index.fileCount} files, ${this.index.chunkCount} chunks in ${Date.now() - started}ms`);
  }

  private schedule(uri: vscode.Uri): void {
    const rel = this.files.relativeOf(uri);
    if (!rel || !isIndexable(rel)) {
      return;
    }
    clearTimeout(this.pending.get(rel));
    this.pending.set(
      rel,
      setTimeout(() => {
        this.pending.delete(rel);
        void this.indexOne(uri, rel);
      }, 300),
    );
  }

  private async indexOne(uri: vscode.Uri, rel: string): Promise<void> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File || stat.size > MAX_FILE_BYTES) {
        return;
      }
      const text = await this.files.read(rel);
      if (text === null || text.includes('\u0000')) {
        this.index.remove(rel);
        return;
      }
      this.index.upsert(rel, text);
    } catch (error) {
      this.log.debug(`index skip ${rel}`, error);
    }
  }

  dispose(): void {
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
