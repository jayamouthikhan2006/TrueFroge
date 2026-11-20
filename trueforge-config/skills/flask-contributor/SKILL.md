---
name: flask-contributor
description: Conventions for adding or changing Flask's built-in CLI commands (click, AppGroup/FlaskGroup, tests/test_cli.py with CliRunner, docs/cli.rst, CHANGES.rst).
---

# Flask contributor: built-in CLI commands

Applies to the `pallets/flask` repository (3.1.x). Read the referenced code with `read_file_range` before editing; line numbers drift between versions, the structure does not.

## Where things live

| Concern | Location |
| --- | --- |
| Command implementations | `src/flask/cli.py`, module level, after `shell_command` / `routes_command` and before the module-level `cli = FlaskGroup(...)` |
| Registration of built-ins | `FlaskGroup.__init__` in `src/flask/cli.py`: inside `if add_default_commands:` it calls `self.add_command(run_command)`, `self.add_command(shell_command)`, `self.add_command(routes_command)` |
| Tests | `tests/test_cli.py` (pytest, `click.testing.CliRunner`, `runner` fixture defined at the top of the file) |
| User docs | `docs/cli.rst` (sections per built-in command such as "Run the Development Server" and "Open a Shell"; headings underlined with `-`) |
| API docs | `docs/api.rst`, section under `.. currentmodule:: flask.cli` |
| Changelog | `CHANGES.rst`, newest version block at the top ("Unreleased" if one exists) |

## Writing a built-in command

Follow `routes_command` exactly:

```python
@click.command("routes", short_help="Show the routes for the app.")
@click.option(...)
@with_appcontext
def routes_command(sort: str, all_methods: bool) -> None:
    """Show all registered routes with endpoints and methods."""
    rules = list(current_app.url_map.iter_rules())
    ...
    click.echo(...)
```

- Decorator order: `@click.command("<name>", short_help="<Sentence.>")`, then options, then `@with_appcontext` last (closest to the function).
- `short_help` is what `flask --help` lists; end it with a period.
- Name the function `<name>_command`, fully type-annotated, returning `None`, with a one-line docstring.
- Use `current_app` (already imported in `cli.py`) inside the app context. Output with `click.echo`, never `print`.
- Register it in `FlaskGroup.__init__` next to the other `self.add_command(...)` calls, otherwise it will not appear in `flask --help`.
- Use only modules `cli.py` already imports or the standard library (`json`, for example). Imports are one per line, sorted, `from __future__ import annotations` stays first.

## Serializing app.config as JSON

`app.config` contains values that `json.dumps` cannot encode (`PERMANENT_SESSION_LIFETIME` and `SEND_FILE_MAX_AGE_DEFAULT` are `timedelta`/`None`, `SECRET_KEY` may be `bytes`). Use `json.dumps(data, indent=2, sort_keys=True, default=str)`. Mask sensitive values by testing the upper-cased key with a substring check, for example `any(word in key.upper() for word in ("SECRET", "PASSWORD", "TOKEN", "KEY"))`, and replace the value with the string `"***"`.

## Testing a command

Mirror `class TestRoutes` in `tests/test_cli.py`:

```python
def test_something(runner):
    app = Flask(__name__)
    app.config["SECRET_KEY"] = "dev"
    cli = FlaskGroup(create_app=lambda: app)
    result = runner.invoke(cli, ["<name>"])
    assert result.exit_code == 0
```

- Parse JSON output with `json.loads(result.output)` and assert on the parsed value instead of substrings.
- Cover both the normal path and the edge (masked keys, empty config, non-serializable values).
- Check `flask --help` lists the command: `runner.invoke(cli, ["--help"])` and assert the name and `short_help` are in `result.output`.
- Run `python -m pytest tests/test_cli.py -q`.

## Documenting a command

In `docs/cli.rst` add a section in the same style as "Open a Shell" (right after it, before `.. _dotenv:`): a title underlined with `-`, a sentence that links the function with ``:func:`<name> <cli.<name>_command>` `` ending in `::`, then an indented literal block showing `$ flask <name>` and its output. Add a bullet to `CHANGES.rst` describing the new command.
