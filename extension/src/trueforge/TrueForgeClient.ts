import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';

export type TurnEvent = TrueForgeApi.TurnStreamingEvent;
export type AgentSpec = TrueForgeApi.AgentSpec;
export type ModelMessageEvent = TrueForgeApi.ModelMessageEvent;
export type ToolCall = TrueForgeApi.ToolCall;

export interface ApprovalDecision {
  threadId: string;
  toolCallId: string;
  allow: boolean;
  reason?: string;
}

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
}

/**
 * Thin typed wrapper over @truefoundry/trueforge-sdk for everything ForgeCode
 * does at runtime: resolve the registered agent, open sessions, stream turns
 * (SSE), resume a stream, answer tool approvals, switch the session's model
 * and cancel. The extension never talks to a model provider directly.
 */
export class TrueForgeClient {
  readonly sdk: TrueForge;
  readonly baseUrl: string;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.sdk = new TrueForge({
      baseUrl: this.baseUrl,
      ...(options.apiKey ? { token: options.apiKey } : { auth: false }),
      timeoutInSeconds: 30,
      maxRetries: 1,
    });
  }

  /** Deep link into the TrueForge UI for a session (turn trace, tool calls, approvals). */
  sessionUrl(sessionId: string): string {
    return `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`;
  }

  async ping(signal?: AbortSignal): Promise<void> {
    await this.sdk.server.getCapabilities({ abortSignal: signal, timeoutInSeconds: 5, maxRetries: 0 });
  }

  async listModels(): Promise<string[]> {
    const response = await this.sdk.models.list({ timeoutInSeconds: 10 });
    return response.data.map((m) => m.name);
  }

  /** The registered agent definition (instructions, MCP servers, approvals, context management). */
  async getAgentSpec(agentName: string): Promise<{ id: string; spec: AgentSpec } | undefined> {
    const page = await this.sdk.agents.list({ agentName, limit: 50 });
    for await (const agent of page) {
      if (agent.name === agentName) {
        return { id: agent.id, spec: agent.manifest };
      }
    }
    return undefined;
  }

  async createSession(spec: AgentSpec, metadata: Record<string, string>): Promise<string> {
    const response = await this.sdk.sessions.create({ agent: { spec }, metadata });
    return response.data.id;
  }

  /** Re-points an existing session at another model; history is kept. Used for failover. */
  async setSessionModel(sessionId: string, spec: AgentSpec, model: string): Promise<void> {
    await this.sdk.sessions.update(sessionId, { agent: { spec: { ...spec, model: { ...spec.model, name: model } } } });
  }

  async setSessionTitle(sessionId: string, title: string): Promise<void> {
    await this.sdk.sessions.update(sessionId, { title: title.slice(0, 50) });
  }

  /** Creates a turn and returns its live SSE event stream. */
  async streamTurn(sessionId: string, text: string, previousTurnId: string | undefined, signal: AbortSignal): Promise<AsyncIterable<TurnEvent>> {
    return this.sdk.sessions.createTurnStream(
      sessionId,
      { input: [{ type: 'user.message', content: text }], previousTurnId: previousTurnId ?? 'auto' },
      { abortSignal: signal, timeoutInSeconds: 24 * 60 * 60, maxRetries: 0 },
    );
  }

  /** Resumes a turn's stream after a dropped connection. */
  async subscribe(sessionId: string, turnId: string, afterEventId: string | undefined, signal: AbortSignal): Promise<AsyncIterable<TurnEvent>> {
    return this.sdk.sessions.subscribeToTurn(sessionId, turnId, afterEventId ? { afterEventId } : {}, { abortSignal: signal, timeoutInSeconds: 24 * 60 * 60, maxRetries: 0 });
  }

  async getTurnState(sessionId: string, turnId: string): Promise<TrueForgeApi.Turn['state']> {
    const response = await this.sdk.sessions.getTurn(sessionId, turnId, { timeoutInSeconds: 10 });
    return response.data.state;
  }

  async submitApprovals(sessionId: string, turnId: string, decisions: ApprovalDecision[]): Promise<void> {
    if (decisions.length === 0) {
      return;
    }
    await this.sdk.sessions.createTurnEvents(sessionId, turnId, {
      events: decisions.map((d) => ({
        type: 'user.tool_approval' as const,
        threadId: d.threadId,
        toolCallId: d.toolCallId,
        approval: d.allow ? { status: 'allow' as const } : { status: 'deny' as const, reason: d.reason ?? 'Denied by the user' },
      })),
    });
  }

  /** Answers client-side tool calls (`tool.response_required`), e.g. TrueForge's ask_user_question. */
  async submitToolResponses(sessionId: string, turnId: string, responses: Array<{ threadId: string; toolCallId: string; content: string }>): Promise<void> {
    if (responses.length === 0) {
      return;
    }
    await this.sdk.sessions.createTurnEvents(sessionId, turnId, {
      events: responses.map((r) => ({ type: 'user.tool_response' as const, threadId: r.threadId, toolCallId: r.toolCallId, content: r.content })),
    });
  }

  /** Cancels the running turn of a session (TrueForge's cancel-turn endpoint). */
  async cancel(sessionId: string): Promise<void> {
    await this.sdk.sessions.cancel(sessionId, {}, { timeoutInSeconds: 10, maxRetries: 1 });
  }
}
