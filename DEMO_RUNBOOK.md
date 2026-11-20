# ForgeCode demo runbook (4:00)

One continuous take covering Tasks A, B and C on `pallets/flask` at `22d92470` (tag 3.1.3). Commands assume bash (Git Bash on Windows) with `forge/` and `flask-eval/` side by side. On macOS/Linux replace `.venv/Scripts/python` with `.venv/bin/python` and `Ctrl` with `Cmd`.

## T-30 min: prepare (off camera)

1. Models in `forge/.env`: a working primary **and** a working fallback (README, *Model configuration*). For Task C you will break only the primary.
2. Bootstrap TrueForge and register everything:

   ```bash
   cd forge && bash scripts/setup-trueforge.sh --restart
   ```

   Check the summary shows both `primary model:` and `fallback model:`, and `agent: forge-coding-agent`.
3. Evaluation repo, pinned and clean:

   ```bash
   git -C ../flask-eval checkout 22d92470 && git -C ../flask-eval checkout -- . && git -C ../flask-eval status --short
   ```

   The last command must print nothing. If the venv is missing, create it as in the README.
4. A sample app for the `flask config` check. Untracked files show in `git status`, so create it only right before verifying (step B5) and delete it after.
5. Open VS Code on the checkout with the extension:

   ```bash
   cd ../flask-eval && code --extensionDevelopmentPath="$PWD/../forge/extension" .
   ```

6. Window layout: editor left, ForgeCode Agent sidebar visible, an integrated terminal (bottom) `cd`'d into `flask-eval`, and a browser tab on `http://localhost:8790` (TrueForge UI). Close all editor tabs. Zoom to 125%.
7. Warm-up (off camera): run one throwaway inline edit, reject it, then `git status --short` (empty). This warms the index, the MCP session and the model.
8. Paste buffer: keep the three prompts below in a scratch note ready to paste.

**Prompt A**

```text
Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
```

**Prompt B**

```text
Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
```

**Prompt A (again, for Task C)**: same as Prompt A.

## Reset between takes

```bash
git -C ../flask-eval checkout -- . && git -C ../flask-eval status --short
```

In VS Code: panel **New chat**; run **ForgeCode: Reject All Pending Hunks** if anything is left over.

## Shot list

| Time | On screen | Do | Say (one line) |
| --- | --- | --- | --- |
| 0:00–0:15 | Panel header | Point at the green **TrueForge** / **MCP** dots, the model dropdown (primary) and the status bar | "ForgeCode runs its whole agent loop on TrueForge; the editor is an MCP server." |
| 0:15–0:20 | TrueForge UI tab | Show the `forge-coding-agent` agent: approvals, deferred tools, sub-agents, compaction | "Approvals, deferred tools, sub-agents and compaction are TrueForge features, declared in one agent definition." |

### Task A: inline edit (0:20–1:15)

| Time | Do | Expect |
| --- | --- | --- |
| 0:20 | Open `src/flask/helpers.py` (Ctrl+P), select the whole `get_debug_flag` function | |
| 0:25 | `Ctrl+Shift+I`, paste Prompt A, Enter | Status bar: *sending to TrueForge…* → *propose edit…* |
| 0:35 | Point at the two hunks | Red/green lines over the docstring and the `return` line, CodeLenses `✓ Accept Hunk  ✗ Reject Hunk  ✓ Accept All in File  ✗ Reject File` |
| 0:40 | In the terminal: `git status --short` | Empty: nothing has been written |
| 0:45 | Click **✓ Accept Hunk** on hunk 1, then on hunk 2 | Decorations clear; file saved |
| 0:50 | Terminal: `FLASK_DEBUG=off .venv/Scripts/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` | `False` |
| 0:55 | Panel **↶ Undo edit** | File reverts; `git status --short` is empty |
| 1:05 | Panel **↷ Redo** | Edit back; `git diff --stat` shows `helpers.py` |
| 1:10 | Panel **↶ Undo edit** again (clean slate for B) | |

### Task B: agent mode (1:15–2:35)

| Time | Do | Expect |
| --- | --- | --- |
| 1:15 | Close all editors. Panel: **New chat**, paste Prompt B, Enter | Streaming text; tool rows appear |
| 1:25 | Expand the **ContextManifest** card | `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst` selected with reasons (*CLI command registration @click.command…*, *pairs with src/flask/cli.py*); meter at about `6,000` tokens |
| 1:40 | Point at the `load_skill` (**deferred** badge) and **sub-agent repo-explorer** rows | Sub-agent's own `search_symbols` call nested under it |
| 1:50 | Pending review cards for 3 files. Click `src/flask/cli.py` → jump | Hunks in the editor: `import json`, `add_command(config_command)`, the new `config_command` |
| 2:00 | Accept per hunk in `cli.py`, then **✓ File** on `tests/test_cli.py` and `docs/cli.rst` | Cards disappear as files finish |
| 2:10 | Approval card *Run `python -m pytest tests/test_cli.py -q`?* → **Allow** | Tool row streams pytest output: `60 passed` |
| 2:20 | Terminal: `.venv/Scripts/python -m pytest tests/test_cli.py -q` | `60 passed` |
| 2:25 | Terminal: `.venv/Scripts/python -m flask --help` | `config  Show the app's configuration as JSON.` |
| 2:28 | Terminal: `printf 'from flask import Flask\napp = Flask(__name__)\napp.config["SECRET_KEY"] = "dev"\n' > demo_app.py && .venv/Scripts/python -m flask --app demo_app config ; rm demo_app.py` | JSON with `"SECRET_KEY": "***"` |

### Streaming and Stop (2:35–2:50)

| Time | Do | Expect |
| --- | --- | --- |
| 2:35 | Terminal: `git -C . checkout -- .` (reset B). Panel: New chat, send *"Refactor routes_command to sort with a key function"* | Tokens stream |
| 2:40 | Press **Esc** (or **■ Stop Generation**) while it streams or while hunks are pending | Status: *Cancelled. Verified: git status shows no changes from this run.* |
| 2:45 | Terminal: `git status --short` | Empty |

### Task C: resilience (2:50–3:30)

Prepared before recording: a second copy of `.env` with `FORGE_PRIMARY_BASE_URL=http://localhost:9999/v1` saved as `.env.taskc`.

| Time | Do | Expect |
| --- | --- | --- |
| 2:50 | Terminal: `(cd ../forge && cp .env .env.good && cp .env.taskc .env && bash scripts/setup-trueforge.sh --skip-build | tail -12)` | Summary still lists both models; primary now points at `localhost:9999` |
| 3:00 | Repeat Task A: select `get_debug_flag`, `Ctrl+Shift+I`, Prompt A | Banner *Primary model failed (Connection Refused). Automatically failing over to Backup Model (…)…* and a toast; the editor stays responsive |
| 3:10 | `git status --short` | Empty while the hunks are pending |
| 3:15 | **✓ Accept All in File** | Same result as Task A, produced by the fallback model |
| 3:20 | Terminal: restore `(cd ../forge && cp .env.good .env && bash scripts/setup-trueforge.sh --skip-build >/dev/null)` | |

### Wrap-up (3:30–4:00)

| Time | Do | Say |
| --- | --- | --- |
| 3:30 | Panel: click the **session …↗** link | TrueForge session trace: turn, approvals (`user.tool_approval`), the failed primary attempt and the fallback turn |
| 3:45 | Back to VS Code; `git status --short` | "Every write went through a reviewed hunk and an undo snapshot." |
| 3:55 | End on the panel | |

## If something goes wrong on camera

- **No hunks appear and the status shows *TrueForge offline***: run `bash scripts/setup-trueforge.sh` in a terminal off-screen. The extension re-provisions within 10 s.
- **The model proposes a different edit**: accept or reject it as is. The review flow is the point; then reset and retake.
- **Leftover pending hunks**: **ForgeCode: Reject All Pending Hunks**.
- **A dirty tree after a take**: `git -C ../flask-eval checkout -- .`
