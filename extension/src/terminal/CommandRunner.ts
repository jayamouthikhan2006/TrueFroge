import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export interface CommandResult {
  command: string;
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  output: string;
  truncated: boolean;
}

export interface RunnerOptions {
  root: string;
  allowedPrefixes: string[];
  timeoutMs: number;
  python: string;
}

export class CommandRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandRefusedError';
  }
}

const MAX_OUTPUT = 30_000;
const HEAD_KEEP = 5_000;

/** Splits a command line like a POSIX shell would for plain words and quotes, refusing shell syntax. */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && (command[i + 1] === '"' || command[i + 1] === '\\')) {
        current += command[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    if (';&|<>`\n\r'.includes(ch) || (ch === '$' && command[i + 1] === '(')) {
      throw new CommandRefusedError(`shell syntax "${ch}" is not allowed; run one plain command (pipes, redirection and chaining are refused)`);
    }
    current += ch;
    hasToken = true;
  }
  if (quote) {
    throw new CommandRefusedError('unterminated quote in command');
  }
  if (hasToken) {
    tokens.push(current);
  }
  return tokens;
}

export class CommandRunner {
  constructor(private readonly options: RunnerOptions) {
    // VS Code reports Windows paths with a lowercase drive letter (c:\...).
    // Python tooling compares cwd against __file__ (C:\...), so normalize it.
    if (process.platform === 'win32' && /^[a-z]:/.test(options.root)) {
      this.options = { ...options, root: options.root[0]!.toUpperCase() + options.root.slice(1) };
    }
  }

  /** Returns the allow-list entry that permits the command, or throws. */
  check(command: string): { argv: string[]; rule: string } {
    const argv = tokenizeCommand(command.trim());
    if (argv.length === 0) {
      throw new CommandRefusedError('command is empty');
    }
    for (const rule of this.options.allowedPrefixes) {
      const ruleTokens = tokenizeCommand(rule);
      if (ruleTokens.length > 0 && ruleTokens.every((t, i) => argv[i] === t)) {
        return { argv, rule };
      }
    }
    throw new CommandRefusedError(`"${argv.slice(0, 3).join(' ')}" is not in forgecode.terminal.allowedCommands (${this.options.allowedPrefixes.join(', ')})`);
  }

  /** Python interpreter: setting, else the workspace .venv/venv, else `python` on PATH. */
  resolvePython(): string {
    if (this.options.python) {
      return this.options.python;
    }
    for (const dir of ['.venv', 'venv', 'env']) {
      const win = join(this.options.root, dir, 'Scripts', 'python.exe');
      const posix = join(this.options.root, dir, 'bin', 'python');
      if (process.platform === 'win32' && existsSync(win)) {
        return win;
      }
      if (existsSync(posix)) {
        return posix;
      }
    }
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  async run(command: string, signal: AbortSignal | undefined, onOutput?: (chunk: string) => void): Promise<CommandResult> {
    const { argv } = this.check(command);
    const python = this.resolvePython();
    // pytest/flask run through the workspace interpreter so the venv's packages are used.
    let exec: string[];
    if (argv[0] === 'python' || argv[0] === 'python3') {
      exec = [python, ...argv.slice(1)];
    } else if (argv[0] === 'pytest') {
      exec = [python, '-m', 'pytest', ...argv.slice(1)];
    } else if (argv[0] === 'flask') {
      exec = [python, '-m', 'flask', ...argv.slice(1)];
    } else {
      exec = argv;
    }

    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', FORCE_COLOR: '0', NO_COLOR: '1' };
    if (isAbsolute(python)) {
      // Activate the venv for child processes (console scripts, subprocess calls).
      const binDir = dirname(python);
      const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
      env[pathKey] = `${binDir}${delimiter}${env[pathKey] ?? ''}`;
      env.VIRTUAL_ENV = dirname(binDir);
    }

    const started = Date.now();
    return new Promise<CommandResult>((resolve) => {
      let output = '';
      let head = '';
      let truncated = false;
      let timedOut = false;
      let cancelled = false;
      const append = (chunk: string) => {
        onOutput?.(chunk);
        output += chunk;
        if (output.length > MAX_OUTPUT) {
          if (!truncated) {
            head = output.slice(0, HEAD_KEEP);
          }
          truncated = true;
          output = output.slice(output.length - (MAX_OUTPUT - HEAD_KEEP));
        }
      };

      const child = spawn(exec[0]!, exec.slice(1), { cwd: this.options.root, env, shell: false, windowsHide: true });
      const kill = () => {
        if (child.exitCode !== null || child.pid === undefined) {
          return;
        }
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGTERM');
          setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 2000);
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        append(`\n[forgecode] timed out after ${this.options.timeoutMs}ms; process killed\n`);
        kill();
      }, this.options.timeoutMs);
      const onAbort = () => {
        cancelled = true;
        append('\n[forgecode] cancelled\n');
        kill();
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf8').on('data', append);
      child.stderr.setEncoding('utf8').on('data', append);
      child.on('error', (error) => append(`\n[forgecode] failed to start ${exec[0]}: ${error.message}\n`));
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({
          command,
          argv: exec,
          exitCode: code,
          timedOut,
          cancelled,
          durationMs: Date.now() - started,
          output: truncated ? `${head}\n[forgecode] ... output truncated ...\n${output}` : output,
          truncated,
        });
      });
    });
  }
}
