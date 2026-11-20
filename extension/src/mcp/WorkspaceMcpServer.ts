import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import * as vscode from 'vscode';
import { z } from 'zod';
import type { ContextEngine, ContextManifest } from '../context/ContextEngine';
import { EXCLUDED_DIRS } from '../context/WorkspaceIndex';
import type { WorkspaceIndexer } from '../context/WorkspaceIndexer';
import type { EditOutcome, PendingEditStore, ProposedEdit } from '../diff/PendingEditStore';
import { CommandRefusedError, type CommandRunner } from '../terminal/CommandRunner';
import type { SkillPack } from '../trueforge/provisioning/ForgeConfig';
import type { ForgeEventBus } from '../util/events';
import { errorMessage, type Logger } from '../util/log';
import type { WorkspaceFiles } from '../workspace/WorkspaceFiles';

export const MCP_SERVER_NAME = 'forgecode-workspace';

/** What the currently running agent/inline turn contributes to tool calls. */
export interface RunContext {
  runId: string;
  mode: 'agent' | 'inline';
  sessionId?: string;
  turnId?: string;
  focusPaths: string[];
  attachedPaths: string[];
  explicitTokens: number;
  signal: AbortSignal;
}

export interface McpDependencies {
  files: WorkspaceFiles;
  indexer: WorkspaceIndexer;
  engine: ContextEngine;
  store: PendingEditStore;
  runner: () => CommandRunner;
  skills: () => SkillPack[];
  tokenBudget: () => number;
  runContext: () => RunContext | undefined;
  bus: ForgeEventBus;
  log: Logger;
}

export interface McpServerOptions {
  host: string;
  port: number;
  token: string;
}

const MAX_READ_LINES = 400;
const MAX_LIST_ENTRIES = 400;
const PROGRESS_INTERVAL_MS = 15_000;

function text(content: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: content }], isError };
}

/** The manifest as the model sees it: what was chosen and why, without UI-only detail. */
export function manifestForModel(manifest: ContextManifest): Record<string, unknown> {
  return {
    budget: `${manifest.budget.used.toLocaleString('en-US')} / ${manifest.budget.limit.toLocaleString('en-US')} tokens (${manifest.budget.explicit} explicit + ${manifest.budget.retrieved} retrieved)`,
    files_considered: manifest.filesConsidered,
    files_selected: manifest.selected.map((f) => ({
      path: f.path,
      score: f.score,
      tokens: f.tokens,
      mode: f.mode,
      reason: f.reason,
      chunks: f.chunks.map((c) => `${c.name} L${c.startLine}-${c.endLine}${c.mode === 'signature' ? ' (signature)' : ''}`),
    })),
    not_selected: manifest.candidates
      .filter((c) => !c.selected)
      .slice(0, 6)
      .map((c) => `${c.path} (${c.score})`),
    pruned: manifest.pruned.slice(0, 5).map((p) => `${p.path}${p.chunk ? ` :: ${p.chunk}` : ''}: ${p.reason}`),
  };
}

export function describeOutcome(edit: ProposedEdit, outcome: EditOutcome): string {
  const total = edit.hunks.length;
  const lines = [
    `propose_edit ${outcome.status}: ${outcome.path}`,
    outcome.message,
    `hunks: ${total} total, ${outcome.accepted.length} accepted${outcome.accepted.length ? ` (#${outcome.accepted.join(', #')})` : ''}, ${outcome.rejected.length} rejected${outcome.rejected.length ? ` (#${outcome.rejected.join(', #')})` : ''}`,
  ];
  if (outcome.status === 'partially_applied') {
    lines.push('Only the accepted hunks were written; the file now differs from your proposal. Re-read it before further edits.');
  }
  if (outcome.status === 'rejected') {
    lines.push('Nothing was written. Do not re-propose the same change; adapt it or ask the user.');
  }
  return lines.join('\n');
}

/**
 * Exposes the VS Code workspace to TrueForge as an MCP server (Streamable HTTP
 * at /mcp, legacy HTTP+SSE at /sse). Bound to loopback and protected by a
 * bearer token that the provisioner registers with TrueForge.
 */
export class WorkspaceMcpServer implements vscode.Disposable {
  private http: HttpServer | undefined;
  private readonly streamable = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
  private readonly sse = new Map<string, { transport: SSEServerTransport; server: McpServer }>();
  private callCount = 0;

  constructor(
    private readonly deps: McpDependencies,
    private readonly options: McpServerOptions,
  ) {}

  get url(): string {
    return `http://${this.options.host}:${this.options.port}/mcp`;
  }

  get stats(): { sessions: number; calls: number } {
    return { sessions: this.streamable.size + this.sse.size, calls: this.callCount };
  }

  async start(): Promise<string> {
    const app = express();
    app.disable('x-powered-by');
    app.use(cors({ origin: false }));
    app.use(express.json({ limit: '8mb' }));

    app.get('/health', (_req, res) => {
      res.json({ ok: true, server: MCP_SERVER_NAME, sessions: this.stats.sessions, calls: this.callCount });
    });

    const auth = (req: Request, res: Response, next: NextFunction) => {
      const host = (req.headers.host ?? '').split(':')[0];
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host ?? '')) {
        res.status(403).json({ error: 'forbidden host' });
        return;
      }
      const header = req.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      const a = Buffer.from(presented);
      const b = Buffer.from(this.options.token);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        res.status(401).json({ error: 'invalid or missing bearer token' });
        return;
      }
      next();
    };

    app.post('/mcp', auth, async (req, res) => {
      try {
        const sessionId = req.headers['mcp-session-id'];
        const existing = typeof sessionId === 'string' ? this.streamable.get(sessionId) : undefined;
        if (existing) {
          await existing.transport.handleRequest(req, res, req.body);
          return;
        }
        if (!isInitializeRequest(req.body)) {
          res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid MCP session; send initialize first' }, id: null });
          return;
        }
        const server = this.buildServer();
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            this.streamable.set(id, { transport, server });
            this.deps.log.info(`MCP session opened (${id})`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            this.streamable.delete(transport.sessionId);
          }
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        this.deps.log.error('MCP POST failed', error);
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: errorMessage(error) }, id: null });
        }
      }
    });

    const sessionRequest = async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'];
      const existing = typeof sessionId === 'string' ? this.streamable.get(sessionId) : undefined;
      if (!existing) {
        res.status(400).send('unknown MCP session');
        return;
      }
      await existing.transport.handleRequest(req, res);
    };
    app.get('/mcp', auth, sessionRequest);
    app.delete('/mcp', auth, sessionRequest);

    app.get('/sse', auth, async (_req, res) => {
      const transport = new SSEServerTransport('/messages', res);
      const server = this.buildServer();
      this.sse.set(transport.sessionId, { transport, server });
      res.on('close', () => this.sse.delete(transport.sessionId));
      await server.connect(transport);
    });
    app.post('/messages', auth, async (req, res) => {
      const id = String(req.query.sessionId ?? '');
      const entry = this.sse.get(id);
      if (!entry) {
        res.status(400).send('unknown SSE session');
        return;
      }
      await entry.transport.handlePostMessage(req, res, req.body);
    });

    await new Promise<void>((resolve, reject) => {
      const server = app.listen(this.options.port, this.options.host, () => resolve());
      server.on('error', reject);
      this.http = server;
    });
    this.deps.log.info(`workspace MCP server listening on ${this.url} (legacy SSE at /sse)`);
    return this.url;
  }

  private buildServer(): McpServer {
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: '0.1.0' },
      {
        capabilities: { tools: {}, logging: {} },
        instructions:
          'VS Code workspace tools. Paths are relative to the workspace root. propose_edit stages edits for per-hunk human review and never writes directly; run_terminal_command runs allow-listed commands in the workspace root.',
      },
    );
    const { deps } = this;
    const track = <A>(name: string, handler: (args: A, extra: ToolExtra) => Promise<CallToolResult>) => {
      return async (args: A, extra: ToolExtra): Promise<CallToolResult> => {
        this.callCount++;
        const started = Date.now();
        try {
          const result = await handler(args, extra);
          deps.log.debug(`tool ${name} ok in ${Date.now() - started}ms`);
          return result;
        } catch (error) {
          deps.log.warn(`tool ${name} failed`, error);
          return text(`${name} failed: ${errorMessage(error)}`, true);
        }
      };
    };

    server.registerTool(
      'retrieve_context',
      {
        title: 'Retrieve budgeted workspace context',
        description:
          'Ranks the whole workspace for a task (0.5 symbol match + 0.3 BM25 + 0.2 path proximity) and packs the best code/doc chunks into a token budget. Returns a ContextManifest (files considered vs. selected, the reason each was selected, tokens used against the budget) followed by the packed context. Call this first for any task.',
        inputSchema: {
          query: z.string().min(3).describe('Natural-language description of the task or what you are looking for.'),
          budget_tokens: z.number().int().min(500).max(64000).optional().describe('Override the token budget (default: the user setting, 6000).'),
          focus_paths: z.array(z.string()).max(20).optional().describe('Workspace-relative paths to rank higher.'),
        },
        annotations: { title: 'Retrieve context', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      track('retrieve_context', async (args: { query: string; budget_tokens?: number; focus_paths?: string[] }) => {
        await deps.indexer.ready();
        const run = deps.runContext();
        const focus = [...(args.focus_paths ?? []).map((p) => safeRelative(deps.files, p)).filter((p): p is string => p !== undefined), ...(run?.focusPaths ?? [])];
        const { manifest, context } = deps.engine.retrieve({
          query: args.query,
          budgetTokens: args.budget_tokens ?? deps.tokenBudget(),
          focusPaths: focus,
          attachedPaths: run?.attachedPaths,
          explicitTokens: run?.explicitTokens,
        });
        deps.bus.emit({ type: 'context.manifest', runId: run?.runId, manifest });
        return text(`ContextManifest:\n\`\`\`json\n${JSON.stringify(manifestForModel(manifest), null, 1)}\n\`\`\`\n\n${context}`);
      }),
    );

    server.registerTool(
      'search_symbols',
      {
        title: 'Search symbols',
        description: 'Finds classes, functions, methods, module-level names and documentation sections by name across the workspace. Returns path, kind, line range and signature.',
        inputSchema: {
          query: z.string().min(1).describe('Symbol name or part of it, e.g. "routes_command" or "FlaskGroup.__init__".'),
          kind: z.enum(['any', 'class', 'function', 'method', 'variable', 'section']).optional(),
          limit: z.number().int().min(1).max(50).optional(),
        },
        annotations: { title: 'Search symbols', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      track('search_symbols', async (args: { query: string; kind?: string; limit?: number }) => {
        await deps.indexer.ready();
        const hits = deps.indexer.index.searchSymbols(args.query, args.kind, args.limit ?? 20);
        if (hits.length === 0) {
          return text(`No symbols match "${args.query}".`);
        }
        return text(hits.map((h) => `${h.path}:${h.startLine}-${h.endLine}  ${h.kind}  ${h.qualifiedName}\n    ${h.signature.slice(0, 200)}`).join('\n'));
      }),
    );

    server.registerTool(
      'read_file_range',
      {
        title: 'Read file range',
        description: `Reads a line-numbered range of a workspace file (1-based, inclusive; at most ${MAX_READ_LINES} lines per call). While a file is under review this returns its current logical content.`,
        inputSchema: {
          path: z.string().min(1),
          start_line: z.number().int().min(1).optional(),
          end_line: z.number().int().min(1).optional(),
        },
        annotations: { title: 'Read file range', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      track('read_file_range', async (args: { path: string; start_line?: number; end_line?: number }) => {
        const rel = deps.files.toRelative(args.path);
        const content = await deps.files.read(rel);
        if (content === null) {
          return text(`${rel} does not exist.`, true);
        }
        const lines = content.split(/\r?\n/);
        const start = Math.max(1, args.start_line ?? 1);
        const end = Math.min(lines.length, args.end_line ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
        if (start > lines.length) {
          return text(`${rel} has only ${lines.length} lines.`, true);
        }
        const width = String(end).length;
        const body = lines
          .slice(start - 1, end)
          .map((line, i) => `${String(start + i).padStart(width)}  ${line}`)
          .join('\n');
        const more = end < lines.length ? `\n... ${lines.length - end} more lines; call again with start_line=${end + 1}` : '';
        return text(`${rel} (lines ${start}-${end} of ${lines.length})\n${body}${more}`);
      }),
    );

    server.registerTool(
      'list_directory',
      {
        title: 'List directory',
        description: 'Lists files and folders under a workspace directory (dependency and build folders are skipped).',
        inputSchema: {
          path: z.string().optional().describe('Workspace-relative directory, default "."'),
          depth: z.number().int().min(1).max(4).optional(),
        },
        annotations: { title: 'List directory', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      track('list_directory', async (args: { path?: string; depth?: number }) => {
        const rel = deps.files.toRelative(args.path ?? '.');
        const out: string[] = [];
        const walk = async (dir: string, depth: number, indent: string) => {
          if (out.length >= MAX_LIST_ENTRIES) {
            return;
          }
          const entries = await vscode.workspace.fs.readDirectory(deps.files.uri(dir));
          entries.sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] === vscode.FileType.Directory ? -1 : 1));
          for (const [name, type] of entries) {
            if (out.length >= MAX_LIST_ENTRIES) {
              out.push(`${indent}...`);
              return;
            }
            const isDir = (type & vscode.FileType.Directory) !== 0;
            if (isDir && (EXCLUDED_DIRS.includes(name) || name.endsWith('.egg-info'))) {
              continue;
            }
            out.push(`${indent}${name}${isDir ? '/' : ''}`);
            if (isDir && depth > 1) {
              await walk(dir === '.' ? name : `${dir}/${name}`, depth - 1, `${indent}  `);
            }
          }
        };
        await walk(rel, args.depth ?? 2, '');
        return text(`${rel}/\n${out.join('\n')}`);
      }),
    );

    server.registerTool(
      'load_skill',
      {
        title: 'Load skill pack',
        description: `Loads a SKILL.md pack with project conventions. Available: ${deps
          .skills()
          .map((s) => `${s.name} (${s.description})`)
          .join('; ') || 'none'}.`,
        inputSchema: { name: z.string().min(1) },
        annotations: { title: 'Load skill', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      track('load_skill', async (args: { name: string }) => {
        const skill = deps.skills().find((s) => s.name === args.name.trim());
        if (!skill) {
          return text(`Unknown skill "${args.name}". Available: ${deps.skills().map((s) => s.name).join(', ')}`, true);
        }
        return text(`# Skill: ${skill.name}\n\n${skill.body}`);
      }),
    );

    server.registerTool(
      'propose_edit',
      {
        title: 'Propose an edit for review',
        description:
          'Stages an edit to ONE file for per-hunk human review in the editor. Never writes directly: the user accepts or rejects each hunk, and the result reports which hunks were applied. Use `edits` (exact search/replace; each old_string must occur exactly once unless replace_all) for existing files, or `new_content` to create a file.',
        inputSchema: {
          path: z.string().min(1).describe('Workspace-relative path of the file to change or create.'),
          description: z.string().min(1).max(500).describe('One sentence describing the change, shown to the reviewer.'),
          edits: z
            .array(
              z.object({
                old_string: z.string().min(1).describe('Exact existing text, including indentation and enough context to be unique.'),
                new_string: z.string().describe('Replacement text (empty string deletes).'),
                replace_all: z.boolean().optional(),
                near_line: z.number().int().positive().optional().describe('If old_string occurs more than once, the 1-based line of the occurrence to change.'),
              }),
            )
            .max(30)
            .optional(),
          new_content: z.string().optional().describe('Full content for a new file.'),
        },
        annotations: { title: 'Propose edit', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      track('propose_edit', async (args: { path: string; description: string; edits?: Array<{ old_string: string; new_string: string; replace_all?: boolean; near_line?: number }>; new_content?: string }, extra) => {
        const run = deps.runContext();
        const edit = await deps.store.stage(args, { source: 'tool', runId: run?.runId, sessionId: run?.sessionId, turnId: run?.turnId });
        if (edit.status === 'failed') {
          deps.store.markConsumed(edit.id);
          return text(`propose_edit failed for ${edit.path}: ${edit.error}`, true);
        }
        // Normally the edit was reviewed during TrueForge's approval pause and
        // is already resolved. Otherwise (approval policy set to allow), wait
        // for the review here, keeping the call alive with progress updates.
        const outcome = await this.awaitWithProgress(edit, extra);
        deps.store.markConsumed(edit.id);
        return text(describeOutcome(edit, outcome), outcome.status === 'failed');
      }),
    );

    server.registerTool(
      'run_terminal_command',
      {
        title: 'Run terminal command',
        description:
          'Runs ONE allow-listed command (e.g. "python -m pytest tests/test_cli.py -q", "flask --help") in the workspace root with the workspace virtualenv. No pipes, redirection or chaining. Returns exit code and output (long output is truncated in the middle).',
        inputSchema: {
          command: z.string().min(1).max(1000),
        },
        annotations: { title: 'Run command', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      track('run_terminal_command', async (args: { command: string }, extra) => {
        const run = deps.runContext();
        const signal = run ? AbortSignal.any([extra.signal, run.signal]) : extra.signal;
        try {
          const result = await deps.runner().run(args.command, signal, (chunk) => deps.bus.emit({ type: 'terminal.output', runId: run?.runId, command: args.command, chunk }));
          const status = result.cancelled ? 'cancelled' : result.timedOut ? 'timed out' : `exit code ${result.exitCode}`;
          deps.log.info(`run_terminal_command "${args.command}": ${status} in ${result.durationMs}ms; tail: ${result.output.trimEnd().split('\n').slice(-1)[0] ?? ''}`);
          return text(`$ ${args.command}\n${status} after ${(result.durationMs / 1000).toFixed(1)}s\n\n${result.output.trimEnd() || '(no output)'}`);
        } catch (error) {
          if (error instanceof CommandRefusedError) {
            return text(`Refused: ${error.message}`, true);
          }
          throw error;
        }
      }),
    );

    return server;
  }

  private async awaitWithProgress(edit: ProposedEdit, extra: ToolExtra): Promise<EditOutcome> {
    if (edit.outcome) {
      return edit.outcome;
    }
    const token = extra._meta?.progressToken;
    let tick = 0;
    const timer =
      token === undefined
        ? undefined
        : setInterval(() => {
            tick++;
            void extra
              .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: tick, message: `waiting for review of ${edit.path}` } })
              .catch(() => undefined);
          }, PROGRESS_INTERVAL_MS);
    const onAbort = () => this.deps.store.discard((e) => e.id === edit.id, 'the tool call was cancelled by TrueForge');
    extra.signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await edit.resolution;
    } finally {
      if (timer) {
        clearInterval(timer);
      }
      extra.signal.removeEventListener('abort', onAbort);
    }
  }

  async stop(): Promise<void> {
    for (const { transport, server } of [...this.streamable.values(), ...this.sse.values()]) {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
    this.streamable.clear();
    this.sse.clear();
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
    this.http = undefined;
  }

  dispose(): void {
    void this.stop();
  }
}

interface ToolExtra {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
}

function safeRelative(files: WorkspaceFiles, path: string): string | undefined {
  try {
    return files.toRelative(path);
  } catch {
    return undefined;
  }
}
