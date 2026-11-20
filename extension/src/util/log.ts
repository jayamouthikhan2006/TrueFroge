export interface Logger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
}

export interface LogSink {
  appendLine(line: string): void;
}

function format(level: string, message: string, data?: unknown): string {
  const time = new Date().toISOString().slice(11, 23);
  if (data === undefined) {
    return `${time} [${level}] ${message}`;
  }
  let rendered: string;
  if (data instanceof Error) {
    rendered = data.stack ?? `${data.name}: ${data.message}`;
  } else {
    try {
      rendered = JSON.stringify(data);
    } catch {
      rendered = String(data);
    }
  }
  return `${time} [${level}] ${message} ${rendered}`;
}

export class SinkLogger implements Logger {
  constructor(
    private readonly sink: LogSink,
    private readonly verbose = false,
  ) {}

  info(message: string, data?: unknown): void {
    this.sink.appendLine(format('info', message, data));
  }

  warn(message: string, data?: unknown): void {
    this.sink.appendLine(format('warn', message, data));
  }

  error(message: string, data?: unknown): void {
    this.sink.appendLine(format('error', message, data));
  }

  debug(message: string, data?: unknown): void {
    if (this.verbose) {
      this.sink.appendLine(format('debug', message, data));
    }
  }
}

export const consoleSink: LogSink = {
  appendLine(line: string): void {
    process.stdout.write(`${line}\n`);
  },
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}
