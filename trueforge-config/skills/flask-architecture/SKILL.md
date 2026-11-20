---
name: flask-architecture
description: Map of Flask's source tree (app/sansio split, helpers, config, contexts, globals) and its environment-flag helpers such as get_debug_flag; load before changing core modules.
---

# Flask architecture map (3.1.x)

## Package layout (`src/flask/`)

| Module | Responsibility |
| --- | --- |
| `app.py` | `Flask` WSGI application: request dispatch, error handling, `run()`, test client factories |
| `sansio/app.py`, `sansio/scaffold.py`, `sansio/blueprints.py` | I/O-free base classes shared by `Flask` and `Blueprint` (route registration, config, error handlers) |
| `blueprints.py` | `Blueprint` with file-serving helpers |
| `cli.py` | `click` integration: `ScriptInfo`, `AppGroup`, `FlaskGroup`, `run`/`shell`/`routes` commands, dotenv loading (see the `flask-contributor` skill) |
| `config.py` | `Config` (a `dict` subclass with `from_object`, `from_pyfile`, `from_prefixed_env`, ...) and `ConfigAttribute` |
| `ctx.py`, `globals.py` | application/request contexts and the `current_app`, `g`, `request`, `session` proxies |
| `helpers.py` | small public helpers: `get_debug_flag`, `get_load_dotenv`, `stream_with_context`, `url_for`, `flash`, `send_file` wrappers |
| `json/` | `flask.json` provider API |
| `testing.py` | `FlaskClient`, `FlaskCliRunner` |

## Environment flag helpers (`helpers.py`)

- `get_debug_flag()` reads `FLASK_DEBUG`; it returns `True` only when the variable is set and its lower-cased value is not one of the false values. Keep the false values in a single literal collection inside the function and keep the docstring listing them in sync.
- `get_load_dotenv(default=True)` reads `FLASK_SKIP_DOTENV` with the same lower-casing convention.
- Both are used by `cli.py` and `app.py`; behaviour changes need a `CHANGES.rst` bullet and tests in `tests/test_helpers.py` (`class TestHelpers` uses `monkeypatch.setenv`).

## Conventions

- `from __future__ import annotations` first, then stdlib, third-party, local imports, one per line.
- Docstrings are reStructuredText; reference env vars with `:envvar:` and code with double backticks.
- Public behaviour changes get a `CHANGES.rst` entry under the newest version heading.
