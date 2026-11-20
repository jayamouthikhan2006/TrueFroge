import { randomUUID } from 'node:crypto';
import { mergeEventDelta } from '@truefoundry/trueforge-sdk';
import * as vscode from 'vscode';
import type { ForgeSettings } from '../config';
import type { EditRequest, PendingEditStore } from '../diff/PendingEditStore';
import { MCP_SERVER_NAME, type RunContext } from '../mcp/WorkspaceMcpServer';
import type { ForgeEventBus, TurnUsage } from '../util/events';
import { errorMessage, type Logger } from '../util/log';
import { gitStatus, statusDelta } from '../workspace/gitStatus';
import type { ApprovalBroker } from './ApprovalBroker';
import { classifyFailure, failoverMessage } from './failover';
import type { AgentSpec, ApprovalDecision, ModelMessageEvent, ToolCall, TrueForgeClient, TurnEvent } from './TrueForgeClient';

export interface RunRequest {
  mode: 'agent' | 'inline';
  /** Full text sent to TrueForge as the user message. */
  prompt: string;
  /** What the UI shows for the request. */
  displayPrompt: string;
  focusPaths: string[];
  attachedPaths: string[];
  explicitTokens: number;
  /** Start a new TrueForge session instead of continuing the panel conversation. */
  freshSession?: boolean;
}

export interface RunResult {
  runId: string;
  status: 'done' | 'cancelled' | 'error';
  message?: string;
  output?: string;
  model?: string;
  sessionId?: string;
  failedOver: boolean;
  workspaceChanges: string[] | undefined;
}

interface ActiveRun {
  id: string;
  mode: RunRequest['mode'];
  request: RunRequest;
  abort: AbortController;
  sessionId?: string;
  turnId?: string;
  model?: string;
  cancelled: boolean;
}

interface SessionState {
  sessionId: string;
  model: string;
  /** Last turn that completed successfully; failed attempts are not chained. */
  lastTurnId?: string;
}

interface TurnOutcome {
  status: 'done' | 'cancelled' | 'error';
  message: string;
  turnId?: string;
  output?: string;
  usage?: TurnUsage;
}

export interface RunnerDependencies {
  client: () => TrueForgeClient;
  settings: () => ForgeSettings;
  catalogModels: () => { primary?: string; fallback?: string };
  provision: () => Promise<void>;
  store: PendingEditStore;
  broker: ApprovalBroker;
  checkCommand: (command: string) => void;
  workspaceRoot: string;
  bus: ForgeEventBus;
  log: Logger;
}

/** A tool call as the user should see it (deferred `call_tool` unwrapped). */
export interface ResolvedToolCall {
  server: string;
  name: string;
  args: Record<string, unknown>;
  raw: string;
  deferred: boolean;
}

export function resolveToolCall(call: ToolCall): ResolvedToolCall {
  const raw = call.function?.arguments ?? '';
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  const info = call.toolInfo;
  if (info?.type === 'truefoundry-system' && call.function?.name === 'call_tool') {
    const input = parsed.input && typeof parsed.input === 'object' ? (parsed.input as Record<string, unknown>) : {};
    return { server: String(parsed.mcp_server ?? ''), name: String(parsed.tool_name ?? 'call_tool'), args: input, raw: JSON.stringify(input), deferred: true };
  }
  if (info?.type === 'mcp') {
    return { server: info.serverName, name: info.name, args: parsed, raw, deferred: false };
  }
  return { server: 'trueforge', name: call.function?.name ?? 'unknown', args: parsed, raw, deferred: false };
}

/** Keeps the head and the tail (where test summaries and errors are) of long tool output. */
function clipMiddle(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const head = Math.floor(max * 0.25);
  return `${text.slice(0, head)}\n… ${text.length - max} characters omitted …\n${text.slice(text.length - (max - head))}`;
}

function messageText(message: ModelMessageEvent): string {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => ('text' in part ? part.text : '')).join('');
  }
  return '';
}

/**
 * Runs agent and inline turns on TrueForge: session handling, SSE streaming,
 * human-in-the-loop approvals, cancellation and automatic model failover.
 */
export class AgentRunner implements vscode.Disposable {
  private active: ActiveRun | undefined;
  private agentSession: SessionState | undefined;
  private agentCache: { name: string; spec: AgentSpec; at: number } | undefined;
  private modelOverride: string | undefined;

  constructor(private readonly deps: RunnerDependencies) {}

  get isRunning(): boolean {
    return this.active !== undefined;
  }

  get currentRun(): { id: string; mode: string; sessionId?: string; turnId?: string; model?: string } | undefined {
    const run = this.active;
    return run ? { id: run.id, mode: run.mode, sessionId: run.sessionId, turnId: run.turnId, model: run.model } : undefined;
  }

  get conversationSessionId(): string | undefined {
    return this.agentSession?.sessionId;
  }

  /** What the MCP server attaches to tool calls made during the active run. */
  runContext(): RunContext | undefined {
    const run = this.active;
    if (!run) {
      return undefined;
    }
    return {
      runId: run.id,
      mode: run.mode,
      sessionId: run.sessionId,
      turnId: run.turnId,
      focusPaths: run.request.focusPaths,
      attachedPaths: run.request.attachedPaths,
      explicitTokens: run.request.explicitTokens,
      signal: run.abort.signal,
    };
  }

  models(): { primary: string | undefined; fallback: string | undefined } {
    const settings = this.deps.settings();
    const catalog = this.deps.catalogModels();
    const primary = this.modelOverride || settings.primaryModel || catalog.primary || this.agentCache?.spec.model.name;
    const fallbackCandidate = settings.fallbackModel || catalog.fallback;
    return { primary, fallback: fallbackCandidate && fallbackCandidate !== primary ? fallbackCandidate : undefined };
  }

  setModelOverride(model: string | undefined): void {
    this.modelOverride = model;
  }

  resetConversation(): void {
    this.agentSession = undefined;
  }

  invalidateAgent(): void {
    this.agentCache = undefined;
  }

  async run(request: RunRequest): Promise<RunResult> {
    if (this.active) {
      throw new Error('A ForgeCode run is already in progress. Stop it first (Esc or Stop Generation).');
    }
    const run: ActiveRun = { id: randomUUID(), mode: request.mode, request, abort: new AbortController(), cancelled: false };
    this.active = run;
    void vscode.commands.executeCommand('setContext', 'forgecode.running', true);
    const { bus, log } = this.deps;
    const result: RunResult = { runId: run.id, status: 'error', failedOver: false, workspaceChanges: undefined };
    const gitBefore = await gitStatus(this.deps.workspaceRoot);
    try {
      const client = this.deps.client();
      await client.ping(run.abort.signal).catch((error: unknown) => {
        throw new Error(`TrueForge is not reachable at ${client.baseUrl} (${errorMessage(error)}). Start it with scripts/setup-trueforge.sh.`);
      });
      const spec = await this.loadAgentSpec(client);
      const { primary, fallback } = this.models();
      if (!primary) {
        throw new Error('No primary model configured. Run scripts/setup-trueforge.sh or set forgecode.models.primary.');
      }
      const chain = fallback && this.deps.settings().failoverEnabled ? [primary, fallback] : [primary];
      bus.emit({ type: 'run.started', runId: run.id, mode: request.mode, prompt: request.displayPrompt, model: primary });

      const session = await this.sessionFor(client, spec, request, primary);
      run.sessionId = session.sessionId;
      bus.emit({ type: 'run.session', runId: run.id, sessionId: session.sessionId, url: client.sessionUrl(session.sessionId) });

      let input = request.prompt;
      let outcome: TurnOutcome | undefined;
      for (let i = 0; i < chain.length; i++) {
        const model = chain[i]!;
        if (session.model !== model) {
          await client.setSessionModel(session.sessionId, spec, model);
          session.model = model;
          log.info(`session ${session.sessionId} now on ${model}`);
        }
        run.model = model;
        outcome = await this.executeTurn(client, run, session, input, model);
        if (outcome.status !== 'error' || run.cancelled) {
          break;
        }
        const failure = classifyFailure(outcome.message);
        const next = chain[i + 1];
        log.warn(`turn failed on ${model}: ${outcome.message} (${failure.kind}, failover=${failure.failover})`);
        if (!failure.failover || !next) {
          if (failure.failover && chain.length > 1) {
            outcome.message = `All configured models failed. Last error (${model}): ${outcome.message}`;
          }
          break;
        }
        const notice = failoverMessage(failure, next);
        result.failedOver = true;
        bus.emit({ type: 'failover', runId: run.id, from: model, to: next, reason: failure.label, detail: outcome.message });
        void vscode.window.showWarningMessage(`ForgeCode: ${notice}`);
        const touched = this.deps.store
          .list()
          .filter((e) => e.origin.runId === run.id && (e.outcome?.accepted.length ?? 0) > 0)
          .map((e) => e.path);
        if (touched.length > 0) {
          input = `${request.prompt}\n\n[ForgeCode note: a previous attempt on another model already applied accepted edits to ${[...new Set(touched)].join(', ')}. Re-read those files before editing them.]`;
        }
      }

      if (outcome) {
        result.status = outcome.status;
        result.message = outcome.message;
        result.output = outcome.output;
        result.model = run.model;
        result.sessionId = session.sessionId;
        if (outcome.status === 'done') {
          session.lastTurnId = outcome.turnId;
        }
        if (outcome.status === 'error') {
          void vscode.window.showErrorMessage(`ForgeCode: ${outcome.message}`);
        }
        bus.emit({ type: 'run.finished', runId: run.id, status: outcome.status, message: outcome.message, usage: outcome.usage });
      }
    } catch (error) {
      const message = errorMessage(error);
      result.status = run.cancelled ? 'cancelled' : 'error';
      result.message = run.cancelled ? 'Cancelled by the user.' : message;
      if (!run.cancelled) {
        log.error('run failed', error);
        void vscode.window.showErrorMessage(`ForgeCode: ${message}`);
      }
      bus.emit({ type: 'run.finished', runId: run.id, status: result.status, message: result.message });
    } finally {
      // Nothing from this run may stay staged once it is over.
      this.deps.store.discard((e) => e.origin.runId === run.id, run.cancelled ? 'Cancelled by the user.' : 'The run ended before this edit was reviewed.');
      this.deps.broker.cancelRun(run.id, 'The run ended.');
      const gitAfter = await gitStatus(this.deps.workspaceRoot);
      result.workspaceChanges = gitBefore && gitAfter ? statusDelta(gitBefore, gitAfter) : undefined;
      if (run.cancelled) {
        const changes = result.workspaceChanges;
        const verdict =
          changes === undefined ? 'Cancelled.' : changes.length === 0 ? 'Cancelled. Verified: git status shows no changes from this run.' : `Cancelled. Files changed by hunks you accepted: ${changes.join(', ')}`;
        bus.emit({ type: 'status', runId: run.id, level: 'info', text: verdict });
      }
      this.active = undefined;
      void vscode.commands.executeCommand('setContext', 'forgecode.running', false);
    }
    return result;
  }

  /** Stop Generation: purge unapproved hunks, abort the stream and tools, cancel the TrueForge turn. */
  async cancel(): Promise<void> {
    const run = this.active;
    if (!run || run.cancelled) {
      return;
    }
    run.cancelled = true;
    const dropped = this.deps.store.discard((e) => e.origin.runId === run.id, 'Cancelled by the user.');
    this.deps.broker.cancelRun(run.id, 'Cancelled by the user.');
    run.abort.abort();
    this.deps.bus.emit({ type: 'status', runId: run.id, level: 'info', text: `Stopping… dropped ${dropped.length} pending edit(s).` });
    if (run.sessionId) {
      await this.deps
        .client()
        .cancel(run.sessionId)
        .catch((error: unknown) => this.deps.log.warn('TrueForge cancel failed', error));
    }
  }

  private async loadAgentSpec(client: TrueForgeClient): Promise<AgentSpec> {
    const name = this.deps.settings().agentName;
    if (this.agentCache && this.agentCache.name === name && Date.now() - this.agentCache.at < 60_000) {
      return this.agentCache.spec;
    }
    let agent = await client.getAgentSpec(name);
    if (!agent) {
      this.deps.log.info(`agent ${name} not registered; provisioning`);
      await this.deps.provision();
      agent = await client.getAgentSpec(name);
    }
    if (!agent) {
      throw new Error(`TrueForge agent "${name}" is not registered. Run scripts/setup-trueforge.sh.`);
    }
    this.agentCache = { name, spec: agent.spec, at: Date.now() };
    return agent.spec;
  }

  private async sessionFor(client: TrueForgeClient, spec: AgentSpec, request: RunRequest, model: string): Promise<SessionState> {
    if (request.mode === 'agent' && !request.freshSession && this.agentSession) {
      return this.agentSession;
    }
    const sessionId = await client.createSession(
      { ...spec, model: { ...spec.model, name: model } },
      { client: 'forgecode-vscode', mode: request.mode, workspace: this.deps.workspaceRoot.split(/[\\/]/).pop() ?? 'workspace' },
    );
    await client.setSessionTitle(sessionId, `${request.mode === 'inline' ? 'Inline: ' : ''}${request.displayPrompt}`).catch(() => undefined);
    const state: SessionState = { sessionId, model };
    if (request.mode === 'agent') {
      this.agentSession = state;
    }
    return state;
  }

  private async executeTurn(client: TrueForgeClient, run: ActiveRun, session: SessionState, input: string, model: string): Promise<TurnOutcome> {
    const { bus, log } = this.deps;
    const attempt = new AbortController();
    const signal = AbortSignal.any([run.abort.signal, attempt.signal]);
    const timeoutMs = this.deps.settings().firstEventTimeoutMs;
    let gotOutput = false;
    let timedOut = false;
    const watchdog = setTimeout(() => {
      if (!gotOutput) {
        timedOut = true;
        attempt.abort();
        void client.cancel(session.sessionId).catch(() => undefined);
      }
    }, timeoutMs);

    const messages = new Map<string, ModelMessageEvent>();
    const announced = new Set<string>();
    const callNames = new Map<string, string>();
    const approvals: Array<Promise<void>> = [];
    let turnId: string | undefined;
    let lastEventId: string | undefined;
    let done: Extract<TurnEvent, { type: 'turn.done' }> | undefined;

    const announce = (message: ModelMessageEvent) => {
      for (const call of message.toolCalls ?? []) {
        if (!call.id || announced.has(call.id) || !call.function?.name) {
          continue;
        }
        announced.add(call.id);
        const resolved = resolveToolCall(call);
        callNames.set(call.id, resolved.name);
        bus.emit({ type: 'tool.started', runId: run.id, callId: call.id, threadId: message.threadId, server: resolved.server, name: resolved.name, args: resolved.raw, deferred: resolved.deferred });
      }
    };

    const handle = (event: TurnEvent) => {
      switch (event.type) {
        case 'turn.created':
          turnId = event.turnId;
          run.turnId = event.turnId;
          bus.emit({ type: 'run.session', runId: run.id, sessionId: session.sessionId, turnId: event.turnId, url: client.sessionUrl(session.sessionId) });
          break;
        case 'model.message': {
          const existing = messages.get(event.id);
          if (!existing) {
            messages.set(event.id, { ...event, toolCalls: event.toolCalls ? [...event.toolCalls] : undefined });
          }
          const text = messageText(event);
          if (text) {
            gotOutput = true;
            bus.emit({ type: 'message.done', runId: run.id, messageId: event.id, threadId: event.threadId, text });
          }
          if (event.toolCalls?.length) {
            gotOutput = true;
            announce(messages.get(event.id)!);
          }
          break;
        }
        case 'model.message.delta': {
          gotOutput = true;
          clearTimeout(watchdog);
          let base = messages.get(event.id);
          if (!base) {
            base = { type: 'model.message', id: event.id, threadId: event.threadId, createdAt: event.createdAt ?? new Date().toISOString() };
            messages.set(event.id, base);
          }
          mergeEventDelta(base, event);
          if (event.content) {
            bus.emit({ type: 'message.delta', runId: run.id, messageId: event.id, threadId: event.threadId, text: event.content });
          }
          if (event.reasoningContent) {
            bus.emit({ type: 'message.delta', runId: run.id, messageId: event.id, threadId: event.threadId, text: event.reasoningContent, reasoning: true });
          }
          if (event.finishReason) {
            announce(base);
            const text = messageText(base);
            if (text) {
              bus.emit({ type: 'message.done', runId: run.id, messageId: event.id, threadId: event.threadId, text });
            }
          }
          break;
        }
        case 'tool.approval_required':
          for (const ref of event.toolCalls) {
            const source = messages.get(ref.sourceEventId);
            if (source) {
              announce(source);
            }
          }
          approvals.push(this.handleApprovals(client, run, session.sessionId, turnId, event, messages));
          break;
        case 'tool.response_required':
          for (const ref of event.toolCalls) {
            const source = messages.get(ref.sourceEventId);
            if (source) {
              announce(source);
            }
          }
          approvals.push(this.handleClientTools(client, run, session.sessionId, turnId, event, messages));
          break;
        case 'tool.response':
          bus.emit({ type: 'tool.finished', runId: run.id, callId: event.toolCallId, name: callNames.get(event.toolCallId) ?? 'tool', result: clipMiddle(event.content, 6000), isError: /^(\w+ failed|Refused:|Unknown skill)/.test(event.content) });
          break;
        case 'thread.created':
          if (event.parent?.threadId) {
            bus.emit({ type: 'subagent.started', runId: run.id, threadId: event.threadId, title: event.title });
          }
          break;
        case 'thread.done':
          if (event.threadId !== 'main') {
            bus.emit({ type: 'subagent.finished', runId: run.id, threadId: event.threadId });
          }
          break;
        case 'thread.context_compaction_started':
          bus.emit({ type: 'compaction', runId: run.id, threadId: event.threadId, phase: 'started' });
          break;
        case 'thread.context_compaction_finished':
          bus.emit({ type: 'compaction', runId: run.id, threadId: event.threadId, phase: 'finished' });
          break;
        case 'turn.update':
          bus.emit({ type: 'status', runId: run.id, level: 'info', text: event.state.status === 'paused' ? 'Waiting for your review/approval…' : `Running on ${model}…` });
          break;
        case 'mcp.auth_required':
          bus.emit({ type: 'status', runId: run.id, level: 'error', text: 'TrueForge needs MCP authorization; re-run "ForgeCode: Register Agent, Models and MCP Server".' });
          break;
        case 'turn.done':
          done = event;
          break;
        default:
          break;
      }
    };

    try {
      let stream = await client.streamTurn(session.sessionId, input, session.lastTurnId ?? 'none', signal);
      let reconnects = 0;
      while (!done) {
        try {
          for await (const event of stream) {
            lastEventId = event.id;
            handle(event);
            if (done) {
              break;
            }
          }
        } catch (error) {
          if (signal.aborted) {
            break;
          }
          log.warn('turn stream interrupted', error);
        }
        if (done || signal.aborted) {
          break;
        }
        // The stream ended without turn.done: resume it from the last event.
        if (!turnId || reconnects >= 3) {
          throw new Error('The TrueForge event stream ended unexpectedly.');
        }
        reconnects++;
        bus.emit({ type: 'status', runId: run.id, level: 'warn', text: `Event stream dropped; resuming (${reconnects}/3)…` });
        stream = await client.subscribe(session.sessionId, turnId, lastEventId, signal);
      }
    } catch (error) {
      if (!signal.aborted) {
        clearTimeout(watchdog);
        return { status: 'error', message: errorMessage(error), turnId };
      }
    } finally {
      clearTimeout(watchdog);
    }
    await Promise.allSettled(approvals);

    if (timedOut) {
      return { status: 'error', message: `[Model Error] Timed out: ${model} produced no output within ${Math.round(timeoutMs / 1000)}s`, turnId };
    }
    if (run.cancelled) {
      return { status: 'cancelled', message: 'Cancelled by the user.', turnId };
    }
    if (!done) {
      return { status: 'error', message: 'The turn ended without a result.', turnId };
    }
    const state = done.state;
    const metrics = state.metrics;
    const usage: TurnUsage | undefined = metrics
      ? { inputTokens: metrics.totalInputTokens ?? 0, outputTokens: metrics.totalOutputTokens ?? 0, totalTokens: metrics.totalTokens ?? 0, costUsd: metrics.totalCostInUsd }
      : undefined;
    if (state.status === 'done') {
      return { status: 'done', message: 'Completed.', turnId, output: state.output ? messageText(state.output) : undefined, usage };
    }
    if (state.status === 'cancelled') {
      return { status: 'cancelled', message: `Cancelled (${state.reason}).`, turnId, usage };
    }
    return { status: 'error', message: state.message, turnId, usage };
  }

  private async handleApprovals(
    client: TrueForgeClient,
    run: ActiveRun,
    sessionId: string,
    turnId: string | undefined,
    event: Extract<TurnEvent, { type: 'tool.approval_required' }>,
    messages: Map<string, ModelMessageEvent>,
  ): Promise<void> {
    const { bus, log } = this.deps;
    const decisions = await Promise.all(
      event.toolCalls.map(async (ref): Promise<ApprovalDecision> => {
        const call = messages.get(ref.sourceEventId)?.toolCalls?.find((t) => t.id === ref.id);
        if (!call) {
          return { threadId: event.threadId, toolCallId: ref.id, allow: false, reason: 'ForgeCode could not find the arguments of this tool call.' };
        }
        const resolved = resolveToolCall(call);
        bus.emit({ type: 'tool.approval', runId: run.id, callId: ref.id, name: resolved.name, state: 'required' });
        let answer: { allow: boolean; reason?: string };
        try {
          answer = await this.decide(run, resolved, { sessionId, turnId, threadId: event.threadId, toolCallId: ref.id });
        } catch (error) {
          answer = { allow: false, reason: `ForgeCode could not process this approval: ${errorMessage(error)}` };
        }
        bus.emit({ type: 'tool.approval', runId: run.id, callId: ref.id, name: resolved.name, state: answer.allow ? 'allowed' : 'denied', reason: answer.reason });
        return { threadId: event.threadId, toolCallId: ref.id, allow: answer.allow, reason: answer.reason };
      }),
    );
    if (run.cancelled || !turnId) {
      return;
    }
    try {
      await client.submitApprovals(sessionId, turnId, decisions);
    } catch (error) {
      log.error('submitting approvals failed', error);
      bus.emit({ type: 'status', runId: run.id, level: 'error', text: `Could not send approval to TrueForge: ${errorMessage(error)}` });
    }
  }

  /**
   * Answers client-side tool calls. TrueForge pauses the turn on
   * `tool.response_required` until the client posts `user.tool_response`;
   * ask_user_question is shown to the user, anything else is answered with an
   * explanation so the turn never hangs.
   */
  private async handleClientTools(
    client: TrueForgeClient,
    run: ActiveRun,
    sessionId: string,
    turnId: string | undefined,
    event: Extract<TurnEvent, { type: 'tool.response_required' }>,
    messages: Map<string, ModelMessageEvent>,
  ): Promise<void> {
    const { bus, broker, log } = this.deps;
    const responses = await Promise.all(
      event.toolCalls.map(async (ref) => {
        const call = messages.get(ref.sourceEventId)?.toolCalls?.find((t) => t.id === ref.id);
        const resolved = call ? resolveToolCall(call) : undefined;
        let content: string;
        if (resolved?.name === 'ask_user_question' && typeof resolved.args.question === 'string') {
          const options = Array.isArray(resolved.args.options)
            ? resolved.args.options.map((o: unknown) => (typeof o === 'string' ? o : typeof (o as { label?: unknown })?.label === 'string' ? (o as { label: string }).label : JSON.stringify(o)))
            : [];
          bus.emit({ type: 'status', runId: run.id, level: 'info', text: `The agent is asking: ${resolved.args.question}` });
          const answer = await broker.ask(run.id, resolved.args.question, options);
          content = answer ? `The user answered: ${answer}` : 'The user did not answer the question. Continue with your best judgement.';
        } else {
          content = `ForgeCode cannot run the client-side tool "${resolved?.name ?? ref.id}". Continue without it.`;
        }
        bus.emit({ type: 'tool.finished', runId: run.id, callId: ref.id, name: resolved?.name ?? 'tool', result: content, isError: false });
        return { threadId: event.threadId, toolCallId: ref.id, content };
      }),
    );
    if (run.cancelled || !turnId) {
      return;
    }
    try {
      await client.submitToolResponses(sessionId, turnId, responses);
    } catch (error) {
      log.error('submitting tool responses failed', error);
      bus.emit({ type: 'status', runId: run.id, level: 'error', text: `Could not send the answer to TrueForge: ${errorMessage(error)}` });
    }
  }

  private async decide(run: ActiveRun, call: ResolvedToolCall, origin: { sessionId: string; turnId?: string; threadId: string; toolCallId: string }): Promise<{ allow: boolean; reason?: string }> {
    if (call.server === MCP_SERVER_NAME && call.name === 'propose_edit') {
      if (typeof call.args.path !== 'string') {
        return { allow: false, reason: 'propose_edit needs a string "path".' };
      }
      const edit = await this.deps.store.stage(call.args as unknown as EditRequest, { source: 'approval', runId: run.id, ...origin });
      if (edit.status === 'failed') {
        return { allow: false, reason: `The edit could not be applied to ${edit.path}: ${edit.error}` };
      }
      const outcome = await edit.resolution;
      if (outcome.accepted.length > 0) {
        return { allow: true };
      }
      return { allow: false, reason: `${outcome.message} Do not re-propose the same change.` };
    }
    if (call.server === MCP_SERVER_NAME && call.name === 'run_terminal_command') {
      const command = String(call.args.command ?? '');
      try {
        this.deps.checkCommand(command);
      } catch (error) {
        return { allow: false, reason: `Refused by ForgeCode: ${errorMessage(error)}` };
      }
      return this.deps.broker.request(run.id, 'command', `Run \`${command}\`?`, `The agent wants to run this command in ${this.deps.workspaceRoot}.`);
    }
    return this.deps.broker.request(run.id, 'tool', `Allow ${call.server}/${call.name}?`, call.raw.slice(0, 400));
  }

  dispose(): void {
    void this.cancel();
  }
}
