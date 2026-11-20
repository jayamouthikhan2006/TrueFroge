# ForgeCode: Editor-Native Coding Agent on TrueForge

## 1. Team

- **Team name:** Domino · **Techfest Team ID:** TM-EFE00783131
- **Members:** Praveen, Dhruthidhar, Jayamouthikhan (GitHub @jayamouthikhan2006)
- **College:** Amrita Vishwa Vidyapeetham, Chennai (all members)
- **Model cost:** $0. The NVIDIA models ran on the free NVIDIA developer API (build.nvidia.com), and no charges were incurred.
- **Repository:** https://github.com/jayamouthikhan2006/TrueFroge · **Demo video:** https://github.com/jayamouthikhan2006/TrueFroge/blob/main/docs/demo/forgecode-demo.mp4

## 2. Starting point

A clean TypeScript VS Code extension built on native APIs: `CodeLensProvider`, `TextEditorDecorationType`, `TextDocumentContentProvider` and a lightweight webview view. No editor-agent project (Continue, Cline, Roo Code) was forked, so there is no upstream agent loop to strip and no fork commit to declare. Third-party code is limited to libraries: `@truefoundry/trueforge-sdk` 0.185.0, `@modelcontextprotocol/sdk` 1.32.2, `diff` 9, `express` 5, `zod` 4 and `yaml` 2. The evaluation target is `pallets/flask` at tag 3.1.3, commit `22d92470`.

## 3. Architecture on TrueForge

**The extension makes zero LLM calls.** Every prompt becomes a TrueForge session turn: `POST /sessions/{id}/turns` with SSE, using the typed SDK. The VS Code workspace is exposed back to TrueForge as an embedded MCP server (Streamable HTTP on `127.0.0.1:8791/mcp`, legacy SSE at `/sse`, bearer-token protected). It provides `retrieve_context`, `search_symbols`, `read_file_range`, `list_directory`, `load_skill`, `propose_edit` and `run_terminal_command`. The agent, not extension logic, decides which of these to call.

The declarative setup lives in `trueforge-config/`:

- `agent-definition.json`: the `forge-coding-agent` manifest.
- `catalog.yaml`: the primary and fallback providers plus the MCP server.
- `instructions/`: the agent instructions.
- `skills/flask-contributor/SKILL.md` and `skills/flask-architecture/SKILL.md`.

`scripts/setup-trueforge.sh` starts `npx @truefoundry/trueforge@latest` and registers all of it through the REST API.

The manifest turns on the following TrueForge features:

| Feature | Setting | Observed in the trace |
| --- | --- | --- |
| Human-in-the-loop approval | `require_approval_for_tools: [propose_edit, run_terminal_command, @destructive]` | `tool.approval_required` → turn `paused` → `user.tool_approval` → `running` on the same SSE stream |
| Deferred tool loading | `preload: false`, `preload_tools: [retrieve_context, propose_edit]` | The model sees `retrieve_context` and `propose_edit` plus `list_tools`/`get_tool_info`/`call_tool`; the other tools load on demand |
| Sub-agent delegation | `dynamic_sub_agents.enabled` + *repo-explorer* brief | `create_sub_agent` → `thread.created` with parent → condensed file map returned |
| Context compaction | `compaction.trigger: input_tokens 60000` | `thread.context_compaction_*` events shown in the panel |
| Large tool response offloading | `large_tool_response.enabled` | Keeps long pytest output and big reads out of the main context |
| Skills | SKILL.md packs | Registered natively from git when TrueForge has a sandbox; otherwise loaded progressively via deferred `load_skill` |

**The key design decision is approvals as the review gate.** `propose_edit` never writes. When TrueForge pauses on its approval, ForgeCode reads the call's arguments from the merged `model.message` (unwrapping deferred `call_tool`). The `PendingEditStore` applies the search/replace edits in memory against the file's current content and computes hunks with `diff`. The `HunkManager` renders those hunks in the editor buffer, with removed lines on `rgba(248,81,73,.25)` and added lines on `rgba(46,160,67,.25)`, plus CodeLenses. When every hunk of a file is decided, ForgeCode:

1. pushes `{uri, previousContent, timestamp, turnId}` onto the `UndoHistoryManager`;
2. writes the accepted hunks byte-exact (save without format-on-save participants);
3. answers TrueForge with `allow` if any hunk was accepted, or `deny` with a reason otherwise.

TrueForge then executes the tool, which reports back which hunks landed. A user save during review strips the preview from the bytes written. Typing in a file under review withdraws its pending hunks. Edits to the same file are serialized and recomputed against the updated text.

**Cancellation.** `Esc` or *Stop Generation* runs these steps:

1. Discards every unapproved staged edit and restores the buffers without writing.
2. Aborts the SSE stream and any running command (process-tree kill).
3. Calls `POST /sessions/{id}/cancel`. Because the turn is paused, the tool never executes.
4. Diffs `git status --porcelain` before and after the run and prints the verdict.

## 4. How context is selected

The `WorkspaceIndex` covers 212 files and 1,539 chunks of Flask, built in under a second and kept current by file watchers. It chunks Python by symbol with an indentation-aware extractor: decorators (including multi-line `@click.option` stacks), multi-line signatures, docstrings, methods and module-level assignments. reStructuredText and Markdown are chunked by section with heading breadcrumbs. Each chunk has a full view and a signature view (decorator heads, `def`, docstring).

Retrieval scores every chunk as **0.5·symbol_match + 0.3·BM25 + 0.2·path_proximity**:

- **symbol_match** is IDF-weighted coverage of the chunk's name and decorator heads. It also includes:
  - an exemplar signal: a decorator whose callable matches the instruction's head clause, e.g. `@click.command` for "add a CLI command";
  - verbatim identifiers from the query (`FLASK_DEBUG`);
  - a reference signal for chunks that name several top matches. This is how `FlaskGroup.__init__` (`self.add_command(routes_command)`) is found.
- **BM25** (k1 1.2, b 0.75) runs over identifier-split, stemmed terms. Name terms count double.
- **path_proximity** combines path-term IDF, test/doc intent, and affinity to `@file` mentions or the active file.

Terms in the instruction's head clause count double. Deliverable words ("covered by a test", "documented") are removed from content matching and drive facets instead.

The packer reserves one *facet leader* each for source, test and doc. Test and doc leaders are chosen by affinity to the source leader (`cli.py` ↔ `test_cli.py` ↔ `cli.rst`), so many similar test files cannot crowd out the docs. It packs greedily into the budget (default 6,000 tokens; `@file`/`@symbol` attachments count against it). It falls back to signatures for low-priority, oversized (over 20% of the budget) or over-represented (over 40%) chunks.

Every call returns a **ContextManifest** to both the model and the panel: files considered vs. selected, score components, chunk ranges and modes, pruning reasons, and tokens used. For Task B it reported `5,997 / 6,000 tokens`, 8 of 173 files, in about 20 ms, with these reasons:

> `src/flask/cli.py`: *Matched CLI command registration @click.command ("shell", "run", "routes"); add_command() registration of shell_command, run_command, routes_command in FlaskGroup.__init__*
> `tests/test_cli.py`: *Matched symbols test_app_cli_has_app_context, …; test module (task asks for tests); pairs with src/flask/cli.py*
> `docs/cli.rst`: *Matched sections Command Line Interface, … Custom Commands; documentation (task asks for docs); pairs with src/flask/cli.py*

## 5. Model setup

TrueForge's model catalog holds a **primary** and a **fallback**, both declared in `catalog.yaml` and filled from `.env`. The configuration used for the demo:

| Role | Model | TrueForge provider | Route |
| --- | --- | --- | --- |
| Primary | NVIDIA Nemotron 3 Ultra (550B-A55B), `nvidia/nvidia/nemotron-3-ultra-550b-a55b` | `forge-primary/primary` (`custom`, OpenAI-compatible) | self-hosted OmniRoute gateway → NVIDIA NIM API key |
| Fallback | NVIDIA Nemotron 3.5 Lightning (30B-A3B), `nvidia/nvidia/nemotron-3.5-lightning-30b-a3b` | `forge-fallback/fallback` (`custom`, OpenAI-compatible) | same gateway, separate TrueForge provider |

TrueForge calls the gateway; the extension calls no model. We also ran Task A on Gemini 3 Flash through TrueForge. Gemini 3.x requires each tool call's `thought_signature` to be sent back, and TrueForge 0.185 drops it, so `scripts/gemini-gateway.mjs` (started by the setup script when a provider points at it) restores the signatures between TrueForge and Google's OpenAI-compatible endpoint. Sessions are created from the registered agent definition with the selected model. On failure, ForgeCode switches the *same session* to the fallback with `PATCH /sessions/{id}` and re-dispatches the turn, without chaining the failed attempt.

TrueForge reports provider failures as `turn.done` with `[Model Error] …`. ForgeCode classifies them:

- **Fail over:** connection refused, 401, 403, 404, 408, 429, 5xx, and ForgeCode's own first-output watchdog (120 s, sized for reasoning models that think before their first token).
- **Stop with the error:** 400/422 and harness-down. Switching models cannot fix these.

On failover the UI shows the banner and toast *"Primary model failed (Connection Refused). Automatically failing over to Backup Model (…)…"*. If every model fails, the run halts in about 170 ms with zero workspace changes. Measured against an unreachable `http://localhost:9999/v1` primary, the full failover-and-edit round trip took about 1.1 s. The panel dropdown and **ForgeCode: Switch Model** pick any catalog model for the next runs.

## 6. Scorecard

| # | Criterion | Video | Claim |
| --- | --- | --- | --- |
| A1 | Inline edit + per-hunk review | _[0:20]_ | `Ctrl+Shift+I` on `get_debug_flag` → 2 hunks with `✓ Accept Hunk / ✗ Reject Hunk / ✓ Accept All in File` CodeLenses → `FLASK_DEBUG=off` prints `False`. |
| A2 | Multi-file agent mode | _[1:15]_ | With no file named, the agent edits `cli.py`, `test_cli.py` and `cli.rst`; `pytest tests/test_cli.py -q` → 60 passed; `flask --app app config` masks `SECRET_KEY` as `"***"`. |
| A3 | Streaming & cancellation | _[2:35]_ | Tokens and tool calls stream live; Stop cancels in about 40 ms, drops staged hunks, and the TrueForge turn ends `cancelled` with `git status` clean. |
| B1 | Context assembly with token budget | _[1:30]_ | The hybrid-scored ContextManifest shows files considered vs. selected, a reason per file and `5,997 / 6,000 tokens` in the budget meter. |
| B2 | Diff safety & undo | _[0:55]_ | Nothing is written before acceptance; Undo/Redo restore exact bytes (git diff empty after undo). |
| B3 | Resilience & failover | _[2:50]_ | Dead primary → banner and toast → automatic re-dispatch on the fallback; all models down → clean halt, no hang, no changes. |
| B4 | TrueForge integration depth | _[3:30]_ | Approval-gated `propose_edit` and `run_terminal_command`, deferred tools, repo-explorer sub-agent, compaction, large-response offloading and SKILL.md packs, all visible in the session trace. |
| C1 | Presentation: demo | _[0:00–4:00]_ | One continuous take of Tasks A, B and C on `pallets/flask@22d92470`, following `DEMO_RUNBOOK.md`. |
| C2 | Presentation: write-up & reproducibility | n/a | Clean-clone setup in one script (`scripts/setup-trueforge.sh`), with README, `.env.example` and this write-up. |

Verification: an end-to-end suite running inside a real VS Code extension host against live TrueForge and the Flask checkout passes 8/8 (Task A, Undo/Redo, cancellation, Task B, Task C failover, all-models-down). It uses a scripted OpenAI-compatible endpoint as the model so it runs without API keys; everything else in the loop is real.

## 7. Tools used

TrueForge 0.185.1 (standalone, SQLite) and `@truefoundry/trueforge-sdk` 0.185.0 · `@modelcontextprotocol/sdk` 1.32.2 · VS Code 1.138 extension API · TypeScript 5.9 · esbuild 0.28 · `diff` 9 · `express` 5 · `zod` 4 · `yaml` 2 · `@vscode/vsce` · Python 3.13 and pytest 8 for the Flask checkout. Claude Code (Anthropic) was used as a coding assistant during development.

## 8. Known limitations and what you would do with another month

**Limitations**

- Native TrueForge skills need a sandbox, and TrueForge's local sandbox is macOS/Linux-only. On Windows the SKILL.md packs are served through the deferred `load_skill` tool instead.
- The Python extractor is indentation- and regex-based, not a full parser.
- Token counts are a calibrated estimate, not a tokenizer.
- Only single-root workspaces are supported, with one active run at a time.
- Accepted hunks reach the disk once per file, when its review completes, not per click.
- Typing in a file under review withdraws its pending hunks rather than merging them.
- Failover re-dispatches the whole turn; there is no mid-stream resume on another model.
- TrueForge must be started with loopback in `OUTBOUND_URL_ALLOWED_HOSTS` to reach the MCP server. The setup script does this.

**With another month**

- Tree-sitter parsing for more languages, plus LSP call/reference graphs feeding the reference signal.
- A real tokenizer per model.
- Embeddings as a fourth retrieval signal, evaluated on a labelled Flask query set.
- Merging manual edits into pending hunks.
- Session-level approval policies (allow-for-session) exposed in the UI.
- Multi-root workspaces and concurrent runs.
- A Linux CI job that runs the e2e suite and native skills inside TrueForge's sandbox.
- Mid-turn failover that resumes from the last completed tool call.
