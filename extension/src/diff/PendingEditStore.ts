import { createHash, randomUUID } from 'node:crypto';
import { applySearchReplace, computeHunks, detectEol, EditApplicationError, type Hunk, type SearchReplace, splitLines, toLf, unifiedDiff } from './hunks';

export interface EditRequest {
  path: string;
  description?: string;
  edits?: SearchReplace[];
  new_content?: string;
}

export interface EditOrigin {
  source: 'approval' | 'tool';
  runId?: string;
  sessionId?: string;
  turnId?: string;
  threadId?: string;
  toolCallId?: string;
}

export type EditStatus = 'queued' | 'reviewing' | 'resolved' | 'discarded' | 'failed';

export interface EditOutcome {
  status: 'applied' | 'partially_applied' | 'rejected' | 'discarded' | 'failed';
  path: string;
  accepted: number[];
  rejected: number[];
  message: string;
}

export interface ProposedEdit {
  id: string;
  key: string;
  path: string;
  description: string;
  request: EditRequest;
  origin: EditOrigin;
  status: EditStatus;
  /** LF-normalized base text at activation; null when the file does not exist yet. */
  baseText: string | null;
  proposedText: string;
  eol: '\r\n' | '\n';
  hunks: Hunk[];
  diff: string;
  error?: string;
  createdAt: number;
  outcome?: EditOutcome;
  resolution: Promise<EditOutcome>;
  /** Set when the MCP tool call has reported this outcome back to the agent. */
  consumed: boolean;
}

export interface FileReader {
  toRelative(path: string): string;
  read(relPath: string): Promise<string | null>;
}

export type StoreEvent =
  | { kind: 'activated'; edit: ProposedEdit }
  | { kind: 'changed'; edit: ProposedEdit }
  | { kind: 'resolved'; edit: ProposedEdit }
  | { kind: 'discarded'; edit: ProposedEdit };

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Holds every edit the agent proposes. Nothing here writes to disk: edits are
 * computed into hunks against the file's current logical content, reviewed in
 * the editor (HunkManager), and resolved with an outcome that the
 * propose_edit tool call and the TrueForge approval step report back.
 *
 * Edits to the same file are serialized: a second proposal waits until the
 * first is resolved and is then computed against the updated content.
 */
export class PendingEditStore {
  private readonly edits = new Map<string, ProposedEdit>();
  private readonly resolvers = new Map<string, (outcome: EditOutcome) => void>();
  private readonly listeners = new Set<(event: StoreEvent) => void>();

  constructor(private readonly files: FileReader) {}

  onEvent(listener: (event: StoreEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  static keyOf(request: EditRequest, relPath: string): string {
    const canonical = JSON.stringify({
      path: relPath,
      edits: (request.edits ?? []).map((e) => [toLf(e.old_string), toLf(e.new_string), Boolean(e.replace_all), e.near_line ?? null]),
      new_content: request.new_content === undefined ? null : toLf(request.new_content),
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  }

  get(id: string): ProposedEdit | undefined {
    return this.edits.get(id);
  }

  list(): ProposedEdit[] {
    return [...this.edits.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  reviewing(): ProposedEdit[] {
    return this.list().filter((e) => e.status === 'reviewing');
  }

  open(): ProposedEdit[] {
    return this.list().filter((e) => e.status === 'reviewing' || e.status === 'queued');
  }

  reviewingFor(relPath: string): ProposedEdit | undefined {
    return this.list().find((e) => e.path === relPath && e.status === 'reviewing');
  }

  /** Finds a staged edit for an identical request (approval-time staging followed by the tool call). */
  findByRequest(request: EditRequest): ProposedEdit | undefined {
    let rel: string;
    try {
      rel = this.files.toRelative(request.path);
    } catch {
      return undefined;
    }
    const key = PendingEditStore.keyOf(request, rel);
    const now = Date.now();
    return this.list()
      .reverse()
      .find((e) => e.key === key && !e.consumed && e.status !== 'discarded' && now - e.createdAt < DEDUPE_WINDOW_MS);
  }

  /** Stages an edit (or returns the identical one already staged). Never touches the disk. */
  async stage(request: EditRequest, origin: EditOrigin): Promise<ProposedEdit> {
    const existing = this.findByRequest(request);
    if (existing) {
      if (origin.toolCallId && !existing.origin.toolCallId) {
        existing.origin = { ...existing.origin, ...origin };
      }
      return existing;
    }
    let rel: string;
    try {
      rel = this.files.toRelative(request.path);
    } catch (error) {
      return this.failed(request, request.path, origin, (error as Error).message);
    }
    let resolve!: (outcome: EditOutcome) => void;
    const resolution = new Promise<EditOutcome>((r) => (resolve = r));
    const edit: ProposedEdit = {
      id: randomUUID(),
      key: PendingEditStore.keyOf(request, rel),
      path: rel,
      description: request.description?.trim() || `Edit ${rel}`,
      request,
      origin,
      status: 'queued',
      baseText: null,
      proposedText: '',
      eol: '\n',
      hunks: [],
      diff: '',
      createdAt: Date.now(),
      resolution,
      consumed: false,
    };
    this.edits.set(edit.id, edit);
    this.resolvers.set(edit.id, resolve);
    if (!this.list().some((e) => e.path === rel && e.status === 'reviewing' && e.id !== edit.id)) {
      await this.activate(edit);
    } else {
      this.emit({ kind: 'changed', edit });
    }
    return edit;
  }

  /** Records the review result for an edit and starts the next queued edit for the same file. */
  resolve(id: string, outcome: Omit<EditOutcome, 'path'>): void {
    const edit = this.edits.get(id);
    if (!edit || (edit.status !== 'reviewing' && edit.status !== 'queued')) {
      return;
    }
    edit.status = 'resolved';
    edit.outcome = { ...outcome, path: edit.path };
    this.settle(edit);
    this.emit({ kind: 'resolved', edit });
    void this.activateNext(edit.path);
  }

  /** Drops unresolved edits (cancellation). Returns what was discarded. */
  discard(predicate: (edit: ProposedEdit) => boolean, reason: string): ProposedEdit[] {
    const dropped: ProposedEdit[] = [];
    for (const edit of this.list()) {
      if ((edit.status === 'reviewing' || edit.status === 'queued') && predicate(edit)) {
        edit.status = 'discarded';
        edit.outcome = { status: 'discarded', path: edit.path, accepted: [], rejected: edit.hunks.map((h) => h.index), message: reason };
        this.settle(edit);
        this.emit({ kind: 'discarded', edit });
        dropped.push(edit);
      }
    }
    return dropped;
  }

  markConsumed(id: string): void {
    const edit = this.edits.get(id);
    if (edit) {
      edit.consumed = true;
    }
  }

  notifyChanged(edit: ProposedEdit): void {
    this.emit({ kind: 'changed', edit });
  }

  /** Forgets resolved edits older than the dedupe window. */
  prune(): void {
    const now = Date.now();
    for (const edit of this.list()) {
      if ((edit.status === 'resolved' || edit.status === 'discarded' || edit.status === 'failed') && now - edit.createdAt > DEDUPE_WINDOW_MS) {
        this.edits.delete(edit.id);
      }
    }
  }

  private async activate(edit: ProposedEdit): Promise<void> {
    try {
      const current = await this.files.read(edit.path);
      const request = edit.request;
      let proposed: string;
      if (request.new_content !== undefined && (!request.edits || request.edits.length === 0)) {
        proposed = toLf(request.new_content);
      } else if (request.edits && request.edits.length > 0) {
        if (current === null) {
          throw new EditApplicationError(`${edit.path} does not exist; use new_content to create it`);
        }
        proposed = applySearchReplace(current, request.edits);
      } else {
        throw new EditApplicationError('provide either edits (search/replace) or new_content');
      }
      const base = current === null ? null : toLf(current);
      if (base !== null && base === proposed) {
        throw new EditApplicationError('the edit produces no change to the file');
      }
      edit.baseText = base;
      edit.eol = current === null ? '\n' : detectEol(current);
      edit.proposedText = proposed;
      // A new file is a single insertion hunk of every line (its base is the empty line list).
      edit.hunks =
        base === null
          ? [{ id: `${edit.id}:0`, index: 0, oldStart: 0, removed: [], added: splitLines(proposed), status: 'pending' }]
          : computeHunks(base, proposed, edit.id);
      edit.diff = unifiedDiff(edit.path, base ?? '', proposed);
      edit.status = 'reviewing';
      this.emit({ kind: 'activated', edit });
    } catch (error) {
      edit.status = 'failed';
      edit.error = (error as Error).message;
      edit.outcome = { status: 'failed', path: edit.path, accepted: [], rejected: [], message: edit.error };
      this.settle(edit);
      this.emit({ kind: 'resolved', edit });
      void this.activateNext(edit.path);
    }
  }

  private async activateNext(relPath: string): Promise<void> {
    if (this.list().some((e) => e.path === relPath && e.status === 'reviewing')) {
      return;
    }
    const next = this.list().find((e) => e.path === relPath && e.status === 'queued');
    if (next) {
      await this.activate(next);
    }
  }

  private failed(request: EditRequest, path: string, origin: EditOrigin, message: string): ProposedEdit {
    const outcome: EditOutcome = { status: 'failed', path, accepted: [], rejected: [], message };
    const edit: ProposedEdit = {
      id: randomUUID(),
      key: 'invalid',
      path,
      description: request.description ?? '',
      request,
      origin,
      status: 'failed',
      baseText: null,
      proposedText: '',
      eol: '\n',
      hunks: [],
      diff: '',
      error: message,
      createdAt: Date.now(),
      outcome,
      resolution: Promise.resolve(outcome),
      consumed: false,
    };
    this.edits.set(edit.id, edit);
    return edit;
  }

  private settle(edit: ProposedEdit): void {
    const resolve = this.resolvers.get(edit.id);
    this.resolvers.delete(edit.id);
    resolve?.(edit.outcome!);
  }

  private emit(event: StoreEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // listeners must not break staging
      }
    }
  }
}
