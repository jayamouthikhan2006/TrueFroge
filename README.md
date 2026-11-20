# ForgeCode: an editor-native coding agent on TrueForge

ForgeCode is a VS Code extension whose entire agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge), TrueFoundry's open-source agent harness. The extension never calls a model provider. It sends every prompt to TrueForge as a session turn, streams the turn's events over SSE, and exposes the editor to the agent as an MCP server. The agent decides what to read, search, edit and run. ForgeCode turns its edit proposals into per-hunk diffs that you accept or reject in the editor.

**Starting point:** written from scratch, not forked. There is no upstream editor-agent project (Cline, Continue, Roo Code, opencode), so there is no fork commit to declare and no upstream agent loop. Third-party code is limited to the libraries in `extension/package.json`. Licence: MIT (`LICENSE`). The agent definition used for the demo is `trueforge-config/agent-definition.json`.

What you get:

- **Inline edit** (`Ctrl+Shift+I` / `Cmd+Shift+I`) on a selection, rendered as red/green per-hunk diffs with `✓ Accept Hunk  ✗ Reject Hunk  ✓ Accept All in File  ✗ Reject File` CodeLenses.
- **Agent mode** in the *ForgeCode Agent* sidebar. It handles multi-file tasks without file names, shows live streaming, a tool trace (deferred tools and sub-agents included), a **context budget meter** with the **ContextManifest**, pending-hunk cards, approval cards, and a deep link to the TrueForge session trace.
- **Budgeted retrieval** (`retrieve_context`): symbol index, BM25 and path proximity, packed into a 6,000-token budget, with a reason for every file it selected.
- **Zero silent writes**: edits are staged in memory and reviewed during TrueForge's tool-approval pause. Nothing reaches the disk until you accept a hunk, and an undo snapshot is taken first.
- **Stop Generation** (`Esc`) aborts the stream, calls TrueForge's cancel endpoint, drops every unapproved hunk and verifies with `git status` that the run changed nothing.
- **Automatic model failover**: when the primary model is unreachable, times out or returns 401/403/429/5xx, the same turn is re-dispatched on the fallback model and the switch is announced in the UI.

## Architecture

```
VS Code extension host
┌──────────────────────────────────────────────────────────────────────────┐
│ InlineEditController   AgentPanelProvider (webview)   HunkManager+CodeLens│
│         │                       │                       ▲   UndoHistory   │
│         └──────────┬────────────┘                       │                 │
│               AgentRunner ── TrueForgeClient (@truefoundry/trueforge-sdk) │
│   sessions · SSE turn stream · approvals · cancel · failover (PATCH model)│
│                    │                          ▲                           │
│                    │      PendingEditStore ───┘ (stage on approval pause) │
│ WorkspaceMcpServer (Streamable HTTP :8791/mcp, legacy SSE /sse, bearer)   │
│   retrieve_context · search_symbols · read_file_range · list_directory    │
│   load_skill · propose_edit · run_terminal_command                        │
│   ContextEngine ← WorkspaceIndex (Python symbols, rst/md sections, BM25)  │
└──────────────┬───────────────────────────────────────────▲───────────────┘
   REST + SSE  │                                    MCP    │
               ▼                                           │
┌──────────────────────────────────────────────────────────┴───────────────┐
│ TrueForge (npx @truefoundry/trueforge@latest · SQLite · :8790)           │
│ agent forge-coding-agent: deferred tool loading, compaction, large tool  │
│ response offloading, dynamic sub-agents, approvals on propose_edit and   │
│ run_terminal_command · model catalog: primary + fallback                 │
└──────────────────────────────────────────────────────────────────────────┘
```

A turn, end to end:

1. ForgeCode creates (or reuses) a TrueForge session from the registered `forge-coding-agent` definition and posts the turn (`POST /sessions/{id}/turns`, SSE).
2. The agent calls `retrieve_context` (preloaded). The other workspace tools are **deferred** and reached through TrueForge's `list_tools` / `get_tool_info` / `call_tool`.
3. When the agent calls `propose_edit`, TrueForge emits `tool.approval_required` and pauses the turn. ForgeCode stages the edit from the call's arguments, renders the hunks in the editor and waits for your decisions. After you accept at least one hunk, ForgeCode writes the accepted hunks (undo snapshot first) and answers the approval with `allow`. If you reject every hunk, it answers `deny` with a reason. TrueForge then executes the tool, which reports which hunks were applied.
4. `run_terminal_command` gets the same checkpoint as an Allow/Deny card, and it is checked against the command allow-list first.
5. On `turn.done` with a `[Model Error]`, the failover policy decides whether to `PATCH` the session onto the fallback model and re-dispatch the turn.

## Quick start (clean clone)

Prerequisites: Node.js 20 or newer, VS Code 1.95 or newer, Python 3.10 or newer, git. Use bash (Git Bash on Windows).

```bash
git clone <this repository> forge && cd forge
```

```bash
cp .env.example .env
```

Fill in at least the primary model in `.env` (see *Model configuration*), then bootstrap TrueForge, build the extension and register everything:

```bash
bash scripts/setup-trueforge.sh
```

The script:

- starts `npx @truefoundry/trueforge@latest` in the background (log in `.logs/trueforge.log`) with `OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'`, so TrueForge can reach the extension's MCP server on loopback;
- builds `extension/`;
- registers the primary and fallback providers, the `forgecode-workspace` MCP server, the skill packs and the `forge-coding-agent` agent;
- prints a summary with the resolved model references.

`--restart` restarts a TrueForge instance that was started without the allow-list.

Prepare the evaluation repository next to this one:

```bash
git clone https://github.com/pallets/flask ../flask-eval
```

```bash
cd ../flask-eval && git checkout 22d92470 && python -m venv .venv
```

```bash
.venv/Scripts/python -m pip install -e . "pytest<9" asgiref greenlet python-dotenv
```

Use `.venv/bin/python` instead of `.venv/Scripts/python` on macOS/Linux. Flask 3.1.3's tests import `_pytest.monkeypatch.notset`, which pytest 9.2 removed, hence `pytest<9`.

Launch VS Code with the extension on the Flask checkout:

```bash
code --extensionDevelopmentPath="$PWD/../forge/extension" .
```

Or install it as a VSIX:

```bash
cd ../forge/extension && npm run package && code --install-extension forgecode-0.1.0.vsix
```

When the extension activates it starts the MCP server, re-registers it with TrueForge using its live port and bearer token, and creates the agent if it is missing. The status bar shows `ForgeCode · <primary model>`, and the panel header shows green TrueForge/MCP indicators.

## Model configuration

Models live in TrueForge's catalog. `trueforge-config/catalog.yaml` declares a `primary` and a `fallback` provider whose values come from `.env`. TrueForge names built-in provider types after the type (`anthropic/fallback`). `custom` (any OpenAI-compatible endpoint) takes an explicit name (`forge-primary/primary`).

OpenAI primary with an Anthropic fallback:

```dotenv
FORGE_PRIMARY_PROVIDER_TYPE=custom
FORGE_PRIMARY_PROVIDER_NAME=forge-primary
FORGE_PRIMARY_BASE_URL=https://api.openai.com/v1
FORGE_PRIMARY_API_KEY=sk-...
FORGE_PRIMARY_MODEL_ID=gpt-4.1

FORGE_FALLBACK_PROVIDER_TYPE=anthropic
FORGE_FALLBACK_API_KEY=sk-ant-...
FORGE_FALLBACK_MODEL_ID=claude-sonnet-5-5
```

Any OpenAI-compatible gateway works as either side (`custom` type). TrueForge calls the endpoint, never the extension:

```dotenv
FORGE_PRIMARY_PROVIDER_TYPE=custom
FORGE_PRIMARY_BASE_URL=https://my-gateway.example.com/v1
FORGE_PRIMARY_API_KEY=...
FORGE_PRIMARY_MODEL_ID=my-model
```

The demo configuration: NVIDIA Nemotron models behind a self-hosted [OmniRoute](https://omniroute.online/) gateway (OpenAI-compatible) backed by an NVIDIA NIM API key:

```dotenv
FORGE_PRIMARY_PROVIDER_TYPE=custom
FORGE_PRIMARY_PROVIDER_NAME=forge-primary
FORGE_PRIMARY_BASE_URL=http://<omniroute-host>:20128/v1
FORGE_PRIMARY_API_KEY=sk-...
FORGE_PRIMARY_MODEL_ID=nvidia/nvidia/nemotron-3-ultra-550b-a55b

FORGE_FALLBACK_PROVIDER_TYPE=custom
FORGE_FALLBACK_PROVIDER_NAME=forge-fallback
FORGE_FALLBACK_BASE_URL=http://<omniroute-host>:20128/v1
FORGE_FALLBACK_API_KEY=sk-...
FORGE_FALLBACK_MODEL_ID=nvidia/nvidia/nemotron-3.5-lightning-30b-a3b
```

**Gemini 3.x.** Gemini 3 models reject the second request of a tool-using turn unless each tool call's `thought_signature` is sent back, and TrueForge 0.185 drops it on both its `google-gemini` and `custom` providers. Route Gemini through the bundled gateway, which restores the signatures (the setup script starts it on `127.0.0.1:8792` when a provider points there):

```dotenv
FORGE_PRIMARY_PROVIDER_TYPE=custom
FORGE_PRIMARY_BASE_URL=http://127.0.0.1:8792/v1beta/openai
FORGE_PRIMARY_API_KEY=<Google AI Studio key>
FORGE_PRIMARY_MODEL_ID=gemini-3-flash-preview
```

For Task C, break the primary on purpose and re-run `bash scripts/setup-trueforge.sh`:

```dotenv
FORGE_PRIMARY_BASE_URL=http://localhost:9999/v1   # connection refused
# or
FORGE_PRIMARY_API_KEY=sk-invalid                    # 401
```

Inside VS Code, `forgecode.models.primary` / `forgecode.models.fallback` override the catalog, and **ForgeCode: Switch Model** (status bar or panel dropdown) picks any model TrueForge knows for the next runs.

## Using it

| Action | How |
| --- | --- |
| Inline edit | Select code, `Ctrl+Shift+I` (`Cmd+Shift+I`), describe the change. With no selection, the enclosing function/class is used. |
| Agent task | *ForgeCode Agent* sidebar → type the task → Enter. No file names needed. |
| Attach context | `@file:src/flask/cli.py`, `@symbol:FlaskGroup.__init__` (autocomplete in the panel). Resolved with VS Code's symbol providers and ForgeCode's index, and counted against the budget. |
| Review | CodeLenses above each hunk, `Ctrl+Shift+Enter` / `Ctrl+Shift+Backspace` at the cursor, or the panel's hunk cards (click to jump). |
| Undo / Redo | **ForgeCode: Undo Last Agent Edit** / **Redo**, or the panel buttons. Restores exact bytes, and deletes files the agent created. |
| Stop | `Esc`, the panel's **■ Stop Generation**, or click the status bar while running. |
| Inspect | **Open Active Session in TrueForge** (turn trace), **Show Last Context Manifest** (full JSON). |

## TrueForge features used

| Feature | Where |
| --- | --- |
| Sessions, turns, SSE streaming, resume (`subscribe`) | `extension/src/trueforge/TrueForgeClient.ts`, `AgentRunner.ts` |
| Human-in-the-loop tool approval | `require_approval_for_tools: [propose_edit, run_terminal_command, @destructive]` in `trueforge-config/agent-definition.json`; answered in `AgentRunner.handleApprovals` |
| Deferred tool loading | `preload: false`, `preload_tools: [retrieve_context, propose_edit]`; the other workspace tools load on demand |
| Context compaction | `config.context_management.compaction` (input-token trigger at 60k) |
| Large tool response offloading | `config.context_management.large_tool_response` |
| Sub-agent delegation | `config.dynamic_sub_agents` + the *repo-explorer* brief in `trueforge-config/instructions/forge-coding-agent.md` |
| Skills | `trueforge-config/skills/*/SKILL.md`, registered natively from git when TrueForge has a sandbox (`FORGECODE_SKILLS_GIT_URL`), otherwise served on demand through the deferred `load_skill` tool |
| Model catalog, failover | `trueforge-config/catalog.yaml`, `PATCH /sessions/{id}` to switch models, `extension/src/trueforge/failover.ts` |
| Agent questions | TrueForge's `ask_user_question` (`tool.response_required`) shown as a question card + notification, answered with `user.tool_response` in `AgentRunner.handleClientTools` |
| Cancellation | `POST /sessions/{id}/cancel` |

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `forgecode.trueforge.baseUrl` | `http://localhost:8790` | TrueForge server |
| `forgecode.trueforge.agentName` | `forge-coding-agent` | Agent definition used for sessions |
| `forgecode.models.primary` / `.fallback` | from `catalog.yaml` | Model overrides |
| `forgecode.failover.enabled` | `true` | Automatic re-dispatch on the fallback |
| `forgecode.failover.firstEventTimeoutMs` | `120000` | No model output within this window counts as a timeout |
| `forgecode.context.tokenBudget` | `6000` | Retrieval budget (explicit mentions count against it) |
| `forgecode.mcp.port` / `.host` | `8791` / `127.0.0.1` | MCP server (falls back to the next free port) |
| `forgecode.terminal.allowedCommands` | `pytest`, `python -m pytest`, `python -c`, `python -m flask`, `flask`, `git status`, `git diff`, `ruff`, `mypy` | Command allow-list (token prefixes; pipes, redirection and chaining are always refused) |

## Repository layout

```
extension/            VS Code extension (TypeScript, bundled with esbuild)
  src/context/        index, Python symbol extractor, chunker, BM25, ContextEngine, @mentions
  src/mcp/            embedded MCP server and its tools
  src/diff/           PendingEditStore, hunk math, HunkManager, CodeLens, UndoHistoryManager
  src/trueforge/      SDK client, AgentRunner, approvals, failover, provisioning
  src/commands/       inline edit controller
  src/webview/        agent panel provider (media/panel.js, panel.css)
  src/cli/provision.ts  provisioning CLI used by scripts/setup-trueforge.sh
trueforge-config/     agent definition, catalog (models + MCP), instructions, skill packs
scripts/              setup-trueforge.sh, gemini-gateway.mjs (Gemini 3.x thought-signature pass-through)
```

## Development

```bash
cd extension && npm install && npm run check
```

`npm run check` type-checks with `tsc` and bundles `dist/extension.js` and `dist/provision.js`. `npm run watch` rebuilds on change.

## Troubleshooting

- **`Outbound URL blocked for host "127.0.0.1"`**: TrueForge was started without the loopback allow-list. Run `bash scripts/setup-trueforge.sh --restart`.
- **Status bar shows "TrueForge offline"**: start it with the setup script. The extension re-provisions automatically once it is reachable.
- **Skills on Windows**: TrueForge runs skills inside a sandbox, and its local sandbox supports macOS/Linux only. ForgeCode then serves the same SKILL.md packs through `load_skill`, and the setup summary says which mode is active.
- **Port 8791 in use**: the MCP server takes the next free port and registers that one with TrueForge.

## License

MIT. See [LICENSE](LICENSE).
