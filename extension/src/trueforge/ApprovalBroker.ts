import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

export interface ApprovalRequest {
  id: string;
  runId: string;
  kind: 'command' | 'tool' | 'question';
  title: string;
  detail: string;
  /** Suggested answers for a question. */
  options?: string[];
  createdAt: number;
}

export interface ApprovalAnswer {
  allow: boolean;
  reason?: string;
  /** The user's answer to a question. */
  text?: string;
}

/**
 * Human-in-the-loop prompts for TrueForge approvals that are not file edits
 * (file edits are approved hunk by hunk in the editor), and for questions the
 * agent asks through TrueForge's ask_user_question tool. A request is shown
 * both as a card in the agent panel and as a notification; whichever the user
 * answers first wins. Cancelling the run denies everything still open.
 */
export class ApprovalBroker implements vscode.Disposable {
  private readonly open = new Map<string, { request: ApprovalRequest; resolve: (answer: ApprovalAnswer) => void }>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  pending(): ApprovalRequest[] {
    return [...this.open.values()].map((o) => o.request);
  }

  request(runId: string, kind: ApprovalRequest['kind'], title: string, detail: string): Promise<ApprovalAnswer> {
    const request: ApprovalRequest = { id: randomUUID(), runId, kind, title, detail, createdAt: Date.now() };
    const answer = new Promise<ApprovalAnswer>((resolve) => this.open.set(request.id, { request, resolve }));
    this.emitter.fire();
    void vscode.window
      .showInformationMessage(`ForgeCode: ${title}`, { detail, modal: false }, 'Allow', 'Deny')
      .then((choice) => {
        if (choice === 'Allow') {
          this.answer(request.id, { allow: true });
        } else if (choice === 'Deny') {
          this.answer(request.id, { allow: false, reason: 'The user denied this action.' });
        }
      });
    return answer;
  }

  /** Asks the user a question on the agent's behalf; resolves to the answer, or undefined if dismissed. */
  async ask(runId: string, question: string, options: string[]): Promise<string | undefined> {
    const request: ApprovalRequest = { id: randomUUID(), runId, kind: 'question', title: question, detail: '', options, createdAt: Date.now() };
    const answer = new Promise<ApprovalAnswer>((resolve) => this.open.set(request.id, { request, resolve }));
    this.emitter.fire();
    const typeOwn = 'Type an answer…';
    void vscode.window.showInformationMessage(`ForgeCode agent asks: ${question}`, ...options.slice(0, 4), typeOwn).then(async (choice) => {
      if (choice === typeOwn) {
        const text = await vscode.window.showInputBox({ prompt: question, ignoreFocusOut: true });
        if (text) {
          this.answer(request.id, { allow: true, text });
        }
      } else if (choice) {
        this.answer(request.id, { allow: true, text: choice });
      }
    });
    const result = await answer;
    return result.allow ? result.text : undefined;
  }

  answer(id: string, answer: ApprovalAnswer): void {
    const entry = this.open.get(id);
    if (!entry) {
      return;
    }
    this.open.delete(id);
    entry.resolve(answer);
    this.emitter.fire();
  }

  cancelRun(runId: string, reason: string): void {
    for (const [id, entry] of [...this.open]) {
      if (entry.request.runId === runId) {
        this.answer(id, { allow: false, reason });
      }
    }
  }

  dispose(): void {
    for (const id of [...this.open.keys()]) {
      this.answer(id, { allow: false, reason: 'VS Code is shutting down' });
    }
    this.emitter.dispose();
  }
}
