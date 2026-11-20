import { diffArrays } from 'diff';
import * as vscode from 'vscode';
import type { ForgeEventBus } from '../util/events';
import { errorMessage, type Logger } from '../util/log';
import { documentLines, revertDocument, saveExactly, setDocumentLines } from '../workspace/documents';
import type { WorkspaceFiles } from '../workspace/WorkspaceFiles';
import { applyHunks, baseLinesOf, type Hunk } from './hunks';
import type { EditOutcome, PendingEditStore, ProposedEdit } from './PendingEditStore';
import type { UndoHistoryManager } from './UndoManager';

export const PREVIEW_SCHEME = 'forgecode-preview';

interface Region {
  /** 0-based [start, end) line ranges inside the rendered preview. */
  removedStart: number;
  removedEnd: number;
  addedStart: number;
  addedEnd: number;
}

interface Review {
  edit: ProposedEdit;
  rel: string;
  fileUri: vscode.Uri;
  /** Where the review is rendered: the file itself, or a read-only preview document for new files. */
  docUri: vscode.Uri;
  isNewFile: boolean;
  baseLines: string[];
  rendered: string[];
  regions: Map<string, Region>;
  wasDirty: boolean;
  queue: Promise<void>;
  finalized: boolean;
  /** True once the preview is rendered; only then is the review offered to the user. */
  ready: boolean;
}

export interface HunkView {
  id: string;
  index: number;
  status: Hunk['status'];
  added: number;
  removed: number;
  /** 1-based line in the editor where the hunk starts. */
  line: number;
  preview: string;
}

export interface ReviewView {
  editId: string;
  path: string;
  description: string;
  isNewFile: boolean;
  toolCallId?: string;
  hunks: HunkView[];
}

export interface LensSpec {
  editId: string;
  hunkId: string;
  index: number;
  total: number;
  line: number;
  description: string;
}

/**
 * Per-hunk review engine. A file under review shows a merged preview in its
 * editor buffer: for each pending hunk the original lines (red) followed by the
 * proposed lines (green), with Accept/Reject CodeLenses above. Decisions only
 * change the buffer; the disk is written once, when every hunk of the file is
 * decided, after an undo snapshot, with a byte-exact save. Rejecting
 * everything (or cancelling) restores the buffer without writing.
 */
export class HunkManager implements vscode.Disposable {
  private readonly reviews = new Map<string, Review>();
  private readonly suppressed = new Map<string, number>();
  private readonly stripOnSave = new Set<string>();
  private readonly previewContent = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly previewEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly disposables: vscode.Disposable[] = [];
  readonly onDidChange = this.changeEmitter.event;

  private readonly addedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(46, 160, 67, 0.25)',
    overviewRulerColor: 'rgba(46, 160, 67, 0.8)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    before: { contentText: '+', color: 'rgba(46, 160, 67, 0.95)', margin: '0 6px 0 0', width: '8px' },
  });

  private readonly removedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(248, 81, 73, 0.25)',
    overviewRulerColor: 'rgba(248, 81, 73, 0.8)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    textDecoration: 'line-through rgba(248, 81, 73, 0.6)',
    before: { contentText: '−', color: 'rgba(248, 81, 73, 0.95)', margin: '0 6px 0 0', width: '8px' },
  });

  constructor(
    private readonly store: PendingEditStore,
    private readonly files: WorkspaceFiles,
    private readonly undo: UndoHistoryManager,
    private readonly bus: ForgeEventBus,
    private readonly log: Logger,
  ) {
    files.setOverlay((rel) => this.logicalContent(rel));
    this.disposables.push(
      this.addedDecoration,
      this.removedDecoration,
      this.changeEmitter,
      this.previewEmitter,
      vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
        onDidChange: this.previewEmitter.event,
        provideTextDocumentContent: (uri) => this.previewContent.get(uri.toString()) ?? '',
      }),
      store.onEvent((event) => {
        if (event.kind === 'activated') {
          void this.open(event.edit);
        } else if (event.kind === 'discarded') {
          this.withdraw(event.edit.id, 'discarded');
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e)),
      vscode.workspace.onWillSaveTextDocument((e) => this.onWillSave(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onDidSave(doc)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorateAll()),
    );
  }

  // ---- Queries -------------------------------------------------------------

  hasPending(): boolean {
    return this.reviews.size > 0;
  }

  isUnderReview(rel: string): boolean {
    return [...this.reviews.values()].some((r) => r.rel === rel);
  }

  snapshot(): ReviewView[] {
    return [...this.reviews.values()].filter((r) => r.ready).map((review) => ({
      editId: review.edit.id,
      path: review.rel,
      description: review.edit.description,
      isNewFile: review.isNewFile,
      toolCallId: review.edit.origin.toolCallId,
      hunks: review.edit.hunks.map((hunk) => {
        const region = review.regions.get(hunk.id);
        const first = hunk.added.find((l) => l.trim()) ?? hunk.removed.find((l) => l.trim()) ?? '';
        return {
          id: hunk.id,
          index: hunk.index,
          status: hunk.status,
          added: hunk.added.length,
          removed: hunk.removed.length,
          line: (region ? Math.min(region.removedStart, region.addedStart) : hunk.oldStart) + 1,
          preview: first.trim().slice(0, 80),
        };
      }),
    }));
  }

  lensesFor(uri: vscode.Uri): LensSpec[] {
    const out: LensSpec[] = [];
    for (const review of this.reviews.values()) {
      if (!review.ready || review.docUri.toString() !== uri.toString()) {
        continue;
      }
      const total = review.edit.hunks.length;
      for (const hunk of review.edit.hunks) {
        const region = review.regions.get(hunk.id);
        if (hunk.status !== 'pending' || !region) {
          continue;
        }
        out.push({ editId: review.edit.id, hunkId: hunk.id, index: hunk.index, total, line: Math.min(region.removedStart, region.addedStart), description: review.edit.description });
      }
    }
    return out;
  }

  /** Logical content of a file under review (base + accepted hunks), used by reads and the index. */
  logicalContent(rel: string): string | undefined {
    const review = [...this.reviews.values()].find((r) => r.rel === rel && !r.isNewFile);
    if (!review) {
      return undefined;
    }
    return applyHunks(review.baseLines, review.edit.hunks, (h) => h.status === 'accepted').join('\n');
  }

  // ---- Decisions -----------------------------------------------------------

  async decide(target: { editId: string; hunkId?: string } | undefined, decision: 'accepted' | 'rejected', scope: 'hunk' | 'file' | 'all'): Promise<void> {
    if (scope === 'all') {
      for (const review of [...this.reviews.values()]) {
        await this.decideHunks(review, review.edit.hunks.filter((h) => h.status === 'pending'), decision);
      }
      return;
    }
    const resolved = target ?? this.targetAtCursor();
    if (!resolved) {
      void vscode.window.showInformationMessage('ForgeCode: no pending hunk here.');
      return;
    }
    const review = this.reviews.get(resolved.editId);
    if (!review) {
      return;
    }
    const hunks =
      scope === 'file' || !resolved.hunkId
        ? review.edit.hunks.filter((h) => h.status === 'pending')
        : review.edit.hunks.filter((h) => h.id === resolved.hunkId && h.status === 'pending');
    await this.decideHunks(review, hunks, decision);
  }

  async jumpTo(editId: string, hunkId?: string): Promise<void> {
    const review = this.reviews.get(editId);
    if (!review) {
      return;
    }
    const region = hunkId ? review.regions.get(hunkId) : [...review.regions.values()][0];
    const editor = await vscode.window.showTextDocument(review.docUri, { preview: false });
    if (region) {
      const line = Math.min(region.removedStart, region.addedStart);
      const range = new vscode.Range(line, 0, Math.max(region.addedEnd, region.removedEnd, line + 1) - 1, 0);
      editor.selection = new vscode.Selection(line, 0, line, 0);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  // ---- Lifecycle -----------------------------------------------------------

  private async open(edit: ProposedEdit): Promise<void> {
    const isNewFile = edit.baseText === null;
    const fileUri = this.files.uri(edit.path);
    const docUri = isNewFile ? vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${edit.path}`, query: `edit=${edit.id}` }) : fileUri;
    const review: Review = {
      edit,
      rel: edit.path,
      fileUri,
      docUri,
      isNewFile,
      baseLines: baseLinesOf(edit.baseText),
      rendered: [],
      regions: new Map(),
      wasDirty: false,
      queue: Promise.resolve(),
      finalized: false,
      ready: false,
    };
    this.reviews.set(edit.id, review);
    await this.enqueue(review, async () => {
      try {
        if (isNewFile) {
          await this.renderNewFile(review);
        } else {
          const document = await vscode.workspace.openTextDocument(fileUri);
          review.wasDirty = document.isDirty;
          const current = documentLines(document);
          if (current.join('\n') !== review.baseLines.join('\n')) {
            throw new Error(`${edit.path} changed while the edit was being staged; ask the agent to re-read it`);
          }
          await this.render(review, document);
          const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
          this.decorate(editor, review);
          const first = [...review.regions.values()][0];
          if (first) {
            editor.revealRange(new vscode.Range(first.removedStart, 0, Math.max(first.addedEnd, first.removedStart + 1), 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          }
        }
        review.ready = true;
        this.log.info(`reviewing ${edit.path}: ${edit.hunks.length} hunk(s) (${edit.description})`);
      } catch (error) {
        this.log.error(`could not open review for ${edit.path}`, error);
        this.reviews.delete(edit.id);
        this.store.resolve(edit.id, { status: 'failed', accepted: [], rejected: [], message: errorMessage(error) });
      }
      this.changed();
    });
  }

  private async decideHunks(review: Review, hunks: Hunk[], decision: 'accepted' | 'rejected'): Promise<void> {
    if (hunks.length === 0) {
      return;
    }
    await this.enqueue(review, async () => {
      if (review.finalized) {
        return;
      }
      for (const hunk of hunks) {
        if (hunk.status === 'pending') {
          hunk.status = decision;
        }
      }
      this.log.info(`${review.rel}: ${decision} hunk(s) ${hunks.map((h) => `#${h.index + 1}`).join(', ')}`);
      if (review.edit.hunks.some((h) => h.status === 'pending')) {
        if (review.isNewFile) {
          return;
        }
        const document = await vscode.workspace.openTextDocument(review.fileUri);
        await this.render(review, document);
        this.decorateVisible(review);
        this.store.notifyChanged(review.edit);
      } else {
        await this.finalize(review);
      }
      this.changed();
    });
  }

  /** Writes the decided result (if anything was accepted) and resolves the edit. */
  private async finalize(review: Review, reason?: string): Promise<void> {
    review.finalized = true;
    const hunks = review.edit.hunks;
    for (const hunk of hunks) {
      if (hunk.status === 'pending') {
        hunk.status = 'rejected';
      }
    }
    const accepted = hunks.filter((h) => h.status === 'accepted').map((h) => h.index);
    const rejected = hunks.filter((h) => h.status === 'rejected').map((h) => h.index);
    const desired = applyHunks(review.baseLines, hunks, (h) => h.status === 'accepted');
    const runId = review.edit.origin.runId;
    const turnId = review.edit.origin.turnId;
    try {
      if (review.isNewFile) {
        this.previewContent.delete(review.docUri.toString());
        await closeEditorsFor(review.docUri);
        if (accepted.length > 0) {
          const text = desired.join(review.edit.eol);
          this.undo.record({ uri: review.fileUri, path: review.rel, previousContent: null, newContent: text, runId, turnId, label: `create ${review.rel}` });
          await vscode.workspace.fs.writeFile(review.fileUri, new TextEncoder().encode(text));
          await vscode.window.showTextDocument(review.fileUri, { preview: false, preserveFocus: true });
        }
      } else {
        const document = await vscode.workspace.openTextDocument(review.fileUri);
        this.clearDecorations(review);
        if (accepted.length > 0) {
          const disk = await this.files.readDisk(review.rel);
          const text = desired.join(review.edit.eol);
          if (disk === null || disk.replace(/\r\n/g, '\n') !== desired.join('\n')) {
            this.undo.record({ uri: review.fileUri, path: review.rel, previousContent: disk, newContent: text, runId, turnId, label: `${review.edit.description} (${accepted.length}/${hunks.length} hunks)` });
          }
          await this.suppress(review.fileUri, async () => {
            await setDocumentLines(document, desired);
            await saveExactly(document);
          });
        } else {
          await this.suppress(review.fileUri, async () => {
            await setDocumentLines(document, review.baseLines);
            if (!review.wasDirty) {
              await revertDocument(document);
            }
          });
        }
      }
    } catch (error) {
      this.log.error(`finalizing ${review.rel} failed`, error);
      void vscode.window.showErrorMessage(`ForgeCode: could not write ${review.rel}: ${errorMessage(error)}`);
      this.reviews.delete(review.edit.id);
      this.store.resolve(review.edit.id, { status: 'failed', accepted: [], rejected: rejected.concat(accepted), message: `writing the file failed: ${errorMessage(error)}` });
      return;
    }
    this.reviews.delete(review.edit.id);
    const status: EditOutcome['status'] = accepted.length === 0 ? 'rejected' : rejected.length === 0 ? 'applied' : 'partially_applied';
    const message =
      reason ??
      (status === 'applied'
        ? `The user accepted all ${hunks.length} hunk(s); the file was written.`
        : status === 'rejected'
          ? `The user rejected all ${hunks.length} hunk(s); nothing was written.`
          : `The user accepted ${accepted.length} of ${hunks.length} hunk(s); only those were written.`);
    // Hunk numbers are 1-based for humans and the model.
    this.store.resolve(review.edit.id, { status, accepted: accepted.map((i) => i + 1), rejected: rejected.map((i) => i + 1), message });
  }

  /** Cancellation/discard: drop pending hunks, keep what the user already accepted. */
  private withdraw(editId: string, why: string): void {
    const review = this.reviews.get(editId);
    if (!review) {
      return;
    }
    void this.enqueue(review, async () => {
      if (review.finalized) {
        return;
      }
      await this.finalize(review, `Review ${why}; pending hunks were dropped.`);
      this.changed();
    });
  }

  // ---- Rendering -----------------------------------------------------------

  private buildPreview(review: Review): { lines: string[]; regions: Map<string, Region> } {
    const lines: string[] = [];
    const regions = new Map<string, Region>();
    let cursor = 0;
    for (const hunk of [...review.edit.hunks].sort((a, b) => a.oldStart - b.oldStart)) {
      lines.push(...review.baseLines.slice(cursor, hunk.oldStart));
      if (hunk.status === 'accepted') {
        lines.push(...hunk.added);
      } else if (hunk.status === 'rejected') {
        lines.push(...hunk.removed);
      } else {
        const removedStart = lines.length;
        lines.push(...hunk.removed);
        const addedStart = lines.length;
        lines.push(...hunk.added);
        regions.set(hunk.id, { removedStart, removedEnd: addedStart, addedStart, addedEnd: lines.length });
      }
      cursor = hunk.oldStart + hunk.removed.length;
    }
    lines.push(...review.baseLines.slice(cursor));
    return { lines, regions };
  }

  private async render(review: Review, document: vscode.TextDocument): Promise<void> {
    const { lines, regions } = this.buildPreview(review);
    await this.suppress(review.fileUri, () => setDocumentLines(document, lines));
    review.rendered = lines;
    review.regions = regions;
  }

  private async renderNewFile(review: Review): Promise<void> {
    const hunk = review.edit.hunks[0]!;
    this.previewContent.set(review.docUri.toString(), hunk.added.join('\n'));
    this.previewEmitter.fire(review.docUri);
    review.rendered = hunk.added;
    review.regions = new Map([[hunk.id, { removedStart: 0, removedEnd: 0, addedStart: 0, addedEnd: hunk.added.length }]]);
    const document = await vscode.workspace.openTextDocument(review.docUri);
    const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
    this.decorate(editor, review);
  }

  private decorate(editor: vscode.TextEditor, review: Review): void {
    const added: vscode.Range[] = [];
    const removed: vscode.Range[] = [];
    for (const region of review.regions.values()) {
      if (region.removedEnd > region.removedStart) {
        removed.push(new vscode.Range(region.removedStart, 0, region.removedEnd - 1, 0));
      }
      if (region.addedEnd > region.addedStart) {
        added.push(new vscode.Range(region.addedStart, 0, region.addedEnd - 1, 0));
      }
    }
    editor.setDecorations(this.addedDecoration, added);
    editor.setDecorations(this.removedDecoration, removed);
  }

  private decorateVisible(review: Review): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === review.docUri.toString()) {
        this.decorate(editor, review);
      }
    }
  }

  private decorateAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const review = [...this.reviews.values()].find((r) => r.docUri.toString() === editor.document.uri.toString());
      if (review) {
        this.decorate(editor, review);
      }
    }
  }

  private clearDecorations(review: Review): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === review.docUri.toString()) {
        editor.setDecorations(this.addedDecoration, []);
        editor.setDecorations(this.removedDecoration, []);
      }
    }
  }

  // ---- Editor events -------------------------------------------------------

  private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    if (event.contentChanges.length === 0) {
      return;
    }
    const key = event.document.uri.toString();
    if ((this.suppressed.get(key) ?? 0) > 0) {
      return;
    }
    const review = [...this.reviews.values()].find((r) => !r.isNewFile && r.fileUri.toString() === key && !r.finalized);
    if (!review) {
      return;
    }
    void this.enqueue(review, async () => {
      if (review.finalized) {
        return;
      }
      await this.absorbManualEdit(review, event.document);
      this.changed();
    });
  }

  /**
   * The user typed into a file under review. Their edit wins: the proposed
   * (green) lines of pending hunks are removed where still intact, pending
   * hunks are withdrawn, and the review is resolved with what was accepted.
   */
  private async absorbManualEdit(review: Review, document: vscode.TextDocument): Promise<void> {
    const current = documentLines(document);
    const mapping = mapLines(review.rendered, current);
    const drop = new Set<number>();
    for (const [hunkId, region] of review.regions) {
      const hunk = review.edit.hunks.find((h) => h.id === hunkId);
      if (hunk?.status !== 'pending') {
        continue;
      }
      for (let i = region.addedStart; i < region.addedEnd; i++) {
        const mapped = mapping.get(i);
        if (mapped !== undefined) {
          drop.add(mapped);
        }
      }
      hunk.status = 'rejected';
    }
    const kept = current.filter((_, i) => !drop.has(i));
    review.finalized = true;
    this.clearDecorations(review);
    await this.suppress(review.fileUri, () => setDocumentLines(document, kept));
    this.reviews.delete(review.edit.id);
    const accepted = review.edit.hunks.filter((h) => h.status === 'accepted').map((h) => h.index + 1);
    const rejected = review.edit.hunks.filter((h) => h.status === 'rejected').map((h) => h.index + 1);
    if (accepted.length > 0) {
      const disk = await this.files.readDisk(review.rel);
      this.undo.record({ uri: review.fileUri, path: review.rel, previousContent: disk, newContent: kept.join(review.edit.eol), runId: review.edit.origin.runId, turnId: review.edit.origin.turnId, label: `${review.edit.description} (with manual edits)` });
      await this.suppress(review.fileUri, () => saveExactly(document));
    }
    void vscode.window.showWarningMessage(`ForgeCode: you edited ${review.rel} during review, so its pending hunks were withdrawn.`);
    this.store.resolve(review.edit.id, {
      status: accepted.length === 0 ? 'rejected' : 'partially_applied',
      accepted,
      rejected,
      message: 'The user edited the file by hand during review; pending hunks were withdrawn. Re-read the file before proposing further edits.',
    });
  }

  /** A user-initiated save during review must never persist the preview lines. */
  private onWillSave(event: vscode.TextDocumentWillSaveEvent): void {
    const key = event.document.uri.toString();
    if ((this.suppressed.get(key) ?? 0) > 0) {
      return;
    }
    const review = [...this.reviews.values()].find((r) => !r.isNewFile && r.fileUri.toString() === key && !r.finalized);
    if (!review) {
      return;
    }
    const logical = applyHunks(review.baseLines, review.edit.hunks, (h) => h.status === 'accepted').join('\n');
    const full = new vscode.Range(0, 0, event.document.lineCount, 0);
    this.stripOnSave.add(key);
    this.suppressed.set(key, (this.suppressed.get(key) ?? 0) + 1);
    event.waitUntil(
      (async () => {
        // Accepted hunks reach the disk with this save: snapshot first so undo covers them.
        if (review.edit.hunks.some((h) => h.status === 'accepted')) {
          const disk = await this.files.readDisk(review.rel);
          if (disk === null || disk.replace(/\r\n/g, '\n') !== logical) {
            this.undo.record({ uri: review.fileUri, path: review.rel, previousContent: disk, newContent: logical.split('\n').join(review.edit.eol), runId: review.edit.origin.runId, turnId: review.edit.origin.turnId, label: `${review.edit.description} (saved during review)` });
          }
        }
        return [vscode.TextEdit.replace(full, logical)];
      })(),
    );
  }

  private onDidSave(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    if (!this.stripOnSave.delete(key)) {
      return;
    }
    this.suppressed.set(key, Math.max(0, (this.suppressed.get(key) ?? 1) - 1));
    const review = [...this.reviews.values()].find((r) => r.fileUri.toString() === key && !r.finalized);
    if (!review) {
      return;
    }
    // The saved file now holds base + accepted; that is the new base for rendering.
    void this.enqueue(review, async () => {
      review.wasDirty = false;
      await this.render(review, document);
      this.decorateVisible(review);
      this.changed();
    });
  }

  // ---- Helpers -------------------------------------------------------------

  private targetAtCursor(): { editId: string; hunkId?: string } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      const first = this.reviews.values().next().value as Review | undefined;
      return first ? { editId: first.edit.id } : undefined;
    }
    const line = editor.selection.active.line;
    const review = [...this.reviews.values()].find((r) => r.docUri.toString() === editor.document.uri.toString());
    if (!review) {
      return undefined;
    }
    let after: string | undefined;
    for (const [hunkId, region] of review.regions) {
      const start = Math.min(region.removedStart, region.addedStart);
      const end = Math.max(region.removedEnd, region.addedEnd);
      if (line >= start && line < Math.max(end, start + 1)) {
        return { editId: review.edit.id, hunkId };
      }
      if (start >= line && after === undefined) {
        after = hunkId;
      }
    }
    return { editId: review.edit.id, hunkId: after ?? [...review.regions.keys()][0] };
  }

  private async suppress<T>(uri: vscode.Uri, fn: () => Promise<T> | Thenable<T>): Promise<T> {
    const key = uri.toString();
    this.suppressed.set(key, (this.suppressed.get(key) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      // Change events for an applied edit are delivered before applyEdit resolves.
      this.suppressed.set(key, Math.max(0, (this.suppressed.get(key) ?? 1) - 1));
    }
  }

  private enqueue(review: Review, op: () => Promise<void>): Promise<void> {
    review.queue = review.queue.then(op, op).catch((error) => this.log.error(`review operation failed for ${review.rel}`, error));
    return review.queue;
  }

  private changed(): void {
    void vscode.commands.executeCommand('setContext', 'forgecode.hasPendingHunks', this.reviews.size > 0);
    this.changeEmitter.fire();
    this.bus.emit({ type: 'edits.changed' });
  }

  dispose(): void {
    for (const review of this.reviews.values()) {
      this.store.discard((e) => e.id === review.edit.id, 'VS Code is shutting down');
    }
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Maps indices of lines that survived unchanged from `before` to their index in `after`. */
function mapLines(before: string[], after: string[]): Map<number, number> {
  const map = new Map<number, number>();
  let a = 0;
  let b = 0;
  for (const change of diffArrays(before, after)) {
    const n = change.value.length;
    if (change.added) {
      b += n;
    } else if (change.removed) {
      a += n;
    } else {
      for (let i = 0; i < n; i++) {
        map.set(a + i, b + i);
      }
      a += n;
      b += n;
    }
  }
  return map;
}

async function closeEditorsFor(uri: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs, true);
  }
}
