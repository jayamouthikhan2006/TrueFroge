import { existsSync, readFileSync } from 'node:fs';

export type Env = Record<string, string | undefined>;

/** Parses a dotenv file: `KEY=value`, optional `export `, quotes, `#` comments. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1]!;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
      }
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) {
        value = value.slice(0, hash).trimEnd();
      }
    }
    out[key] = value;
  }
  return out;
}

/** Process environment wins over the file, so CI/shell overrides keep working. */
export function loadEnv(dotEnvPaths: string[], base: Env = process.env): Env {
  const merged: Env = {};
  for (const path of dotEnvPaths) {
    if (existsSync(path)) {
      Object.assign(merged, parseDotEnv(readFileSync(path, 'utf8')));
    }
  }
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

export class MissingVariableError extends Error {
  constructor(readonly variable: string) {
    super(`environment variable ${variable} is not set`);
    this.name = 'MissingVariableError';
  }
}

/**
 * Expands `${VAR}` and `${VAR:-default}`. `${VAR}` with no default throws
 * MissingVariableError when VAR is unset or empty, so callers can skip the
 * enclosing block instead of registering half-configured resources.
 */
export function expand(template: string, env: Env): string {
  return template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_whole, name: string, hasDefault: string | undefined, fallback: string | undefined) => {
    const value = env[name];
    if (value !== undefined && value !== '') {
      return value;
    }
    if (hasDefault !== undefined) {
      return fallback ?? '';
    }
    throw new MissingVariableError(name);
  });
}

/** Deep-expands every string leaf of a parsed YAML/JSON value. */
export function expandDeep<T>(value: T, env: Env): T {
  if (typeof value === 'string') {
    return expand(value, env) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandDeep(item, env)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = expandDeep(item, env);
    }
    return out as T;
  }
  return value;
}
