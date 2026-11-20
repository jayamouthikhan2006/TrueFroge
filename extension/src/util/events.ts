import type { ContextManifest } from '../context/ContextEngine';

/** Everything the UI (agent panel, inline controller, status bar) can observe. */
export type ForgeEvent =
  | { type: 'run.started'; runId: string; mode: 'agent' | 'inline'; prompt: string; model: string }
  | { type: 'run.session'; runId: string; sessionId: string; turnId?: string; url: string }
  | { type: 'run.finished'; runId: string; status: 'done' | 'cancelled' | 'error'; message?: string; usage?: TurnUsage }
  | { type: 'message.delta'; runId: string; messageId: string; threadId: string; text: string; reasoning?: boolean }
  | { type: 'message.done'; runId: string; messageId: string; threadId: string; text: string }
  | { type: 'tool.started'; runId: string; callId: string; threadId: string; server?: string; name: string; args: string; deferred: boolean }
  | { type: 'tool.approval'; runId: string; callId: string; name: string; state: 'required' | 'allowed' | 'denied'; reason?: string }
  | { type: 'tool.finished'; runId: string; callId: string; name: string; result: string; isError: boolean }
  | { type: 'subagent.started'; runId: string; threadId: string; title: string }
  | { type: 'subagent.finished'; runId: string; threadId: string }
  | { type: 'compaction'; runId: string; threadId: string; phase: 'started' | 'finished' }
  | { type: 'context.manifest'; runId?: string; manifest: ContextManifest }
  | { type: 'context.explicit'; runId: string; tokens: number; items: Array<{ mention: string; path: string; startLine: number; endLine: number; tokens: number }> }
  | { type: 'failover'; runId: string; from: string; to: string; reason: string; detail: string }
  | { type: 'status'; runId?: string; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'terminal.output'; runId?: string; command: string; chunk: string }
  | { type: 'edits.changed' }
  | { type: 'undo.changed'; canUndo: boolean; canRedo: boolean; label?: string };

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}

type Listener = (event: ForgeEvent) => void;

export class ForgeEventBus {
  private readonly listeners = new Set<Listener>();

  on(listener: Listener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit(event: ForgeEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A faulty listener must never break the run loop.
      }
    }
  }
}
