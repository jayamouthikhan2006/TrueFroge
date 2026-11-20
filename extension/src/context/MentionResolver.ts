import * as vscode from 'vscode';
import type { WorkspaceFiles } from '../workspace/WorkspaceFiles';
import { estimateTokens } from './tokens';
import { normalizePath, type WorkspaceIndex } from './WorkspaceIndex';

export interface ResolvedMention {
  mention: string;
  kind: 'file' | 'symbol';
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  tokens: number;
  truncated: boolean;
}

export interface MentionResolution {
  items: ResolvedMention[];
  unresolved: string[];
  tokens: number;
}

/** `@file:src/flask/cli.py`, `@file:"docs/my file.rst"`, `@symbol:get_debug_flag`, `@symbol:FlaskGroup.__init__`. */
export const MENTION_RE = /@(file|symbol):("[^"]+"|[^\s,;)]+)/g;

export function parseMentions(text: string): Array<{ raw: string; kind: 'file' | 'symbol'; value: string }> {
  const out: Array<{ raw: string; kind: 'file' | 'symbol'; value: string }> = [];
  for (const match of text.matchAll(MENTION_RE)) {
    const value = match[2]!.replace(/^"|"$/g, '').replace(/[.:]+$/, '');
    out.push({ raw: match[0], kind: match[1] as 'file' | 'symbol', value });
  }
  return out;
}

/**
 * Resolves explicit mentions with VS Code's own providers first
 * (workspace/document symbol providers, i.e. whatever language server is
 * installed), falling back to ForgeCode's index when no provider answers.
 */
export class MentionResolver {
  constructor(
    private readonly files: WorkspaceFiles,
    private readonly index: WorkspaceIndex,
  ) {}

  async resolve(text: string, perItemTokenCap: number): Promise<MentionResolution> {
    const items: ResolvedMention[] = [];
    const unresolved: string[] = [];
    const seen = new Set<string>();
    for (const mention of parseMentions(text)) {
      if (seen.has(mention.raw)) {
        continue;
      }
      seen.add(mention.raw);
      const item = mention.kind === 'file' ? await this.resolveFile(mention.raw, mention.value, perItemTokenCap) : await this.resolveSymbol(mention.raw, mention.value, perItemTokenCap);
      if (item) {
        items.push(item);
      } else {
        unresolved.push(mention.raw);
      }
    }
    return { items, unresolved, tokens: items.reduce((sum, i) => sum + i.tokens, 0) };
  }

  /** Suggestions for the panel's @-autocomplete. */
  suggest(kind: 'file' | 'symbol', query: string, limit = 12): Array<{ label: string; detail: string; insert: string }> {
    const q = query.toLowerCase();
    if (kind === 'symbol') {
      return this.index.searchSymbols(query || 'a', 'any', limit).map((hit) => ({
        label: hit.qualifiedName,
        detail: `${hit.kind} · ${hit.path}:${hit.startLine}`,
        insert: `@symbol:${hit.qualifiedName}`,
      }));
    }
    const scored: Array<{ path: string; score: number }> = [];
    for (const file of this.index.allFiles()) {
      const p = file.path.toLowerCase();
      const base = p.split('/').pop()!;
      let score = 0;
      if (q.length === 0) {
        score = 0.1;
      } else if (base.startsWith(q)) {
        score = 1;
      } else if (base.includes(q)) {
        score = 0.8;
      } else if (p.includes(q)) {
        score = 0.6;
      } else if (isSubsequence(q, p)) {
        score = 0.3;
      }
      if (score > 0) {
        scored.push({ path: file.path, score: score - p.length / 10000 });
      }
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ label: s.path.split('/').pop()!, detail: s.path, insert: `@file:${s.path.includes(' ') ? `"${s.path}"` : s.path}` }));
  }

  private async resolveFile(raw: string, value: string, cap: number): Promise<ResolvedMention | undefined> {
    let rel: string | undefined;
    try {
      const candidate = this.files.toRelative(value);
      if (await this.files.exists(candidate)) {
        rel = candidate;
      }
    } catch {
      rel = undefined;
    }
    if (!rel) {
      const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(this.files.root, `**/${value.replace(/^\.?\/+/, '')}`), '**/node_modules/**', 2);
      rel = matches[0] ? this.files.relativeOf(matches[0]) : undefined;
    }
    if (!rel) {
      const byName = [...this.index.allFiles()].find((f) => f.path.endsWith(`/${normalizePath(value)}`) || f.path === normalizePath(value));
      rel = byName?.path;
    }
    if (!rel) {
      return undefined;
    }
    const text = await this.files.read(rel);
    if (text === null) {
      return undefined;
    }
    const lines = text.split(/\r?\n/);
    return this.clip(raw, 'file', rel, 1, lines.length, lines, cap);
  }

  private async resolveSymbol(raw: string, value: string, cap: number): Promise<ResolvedMention | undefined> {
    const leaf = value.split('.').pop()!;
    let location: { rel: string; start: number; end: number } | undefined;

    const workspaceSymbols = await vscode.commands
      .executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', leaf)
      .then((r) => r ?? [], () => [] as vscode.SymbolInformation[]);
    const exact = workspaceSymbols.filter((s) => s.name === leaf && (value === leaf || `${s.containerName}.${s.name}`.endsWith(value)));
    for (const symbol of exact) {
      const rel = this.files.relativeOf(symbol.location.uri);
      if (!rel) {
        continue;
      }
      const full = await this.documentSymbolRange(symbol.location.uri, symbol.location.range.start, leaf);
      const range = full ?? symbol.location.range;
      location = { rel, start: range.start.line + 1, end: range.end.line + 1 };
      break;
    }

    if (!location) {
      const hit = this.index.searchSymbols(value, 'any', 5).find((h) => h.qualifiedName === value || h.name === leaf) ?? this.index.searchSymbols(value, 'any', 1)[0];
      if (hit && hit.score >= 0.7) {
        location = { rel: hit.path, start: hit.startLine, end: hit.endLine };
      }
    }
    if (!location) {
      return undefined;
    }
    const text = await this.files.read(location.rel);
    if (text === null) {
      return undefined;
    }
    return this.clip(raw, 'symbol', location.rel, location.start, location.end, text.split(/\r?\n/), cap);
  }

  /** Workspace symbol locations often cover only the name; the document symbol has the full body range. */
  private async documentSymbolRange(uri: vscode.Uri, at: vscode.Position, name: string): Promise<vscode.Range | undefined> {
    const symbols = await vscode.commands
      .executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>('vscode.executeDocumentSymbolProvider', uri)
      .then((r) => r ?? [], () => []);
    const walk = (list: Array<vscode.DocumentSymbol | vscode.SymbolInformation>): vscode.Range | undefined => {
      for (const s of list) {
        if ('children' in s) {
          if (s.name === name && s.range.contains(at)) {
            return s.range;
          }
          const inner = walk(s.children);
          if (inner) {
            return inner;
          }
        } else if (s.name === name && s.location.range.contains(at)) {
          return s.location.range;
        }
      }
      return undefined;
    };
    return walk(symbols);
  }

  private clip(raw: string, kind: 'file' | 'symbol', rel: string, start: number, end: number, lines: string[], cap: number): ResolvedMention {
    let last = Math.min(end, lines.length);
    let text = lines.slice(start - 1, last).join('\n');
    let tokens = estimateTokens(text);
    let truncated = false;
    if (tokens > cap) {
      // Keep the head of the range within the cap; the agent can read the rest.
      truncated = true;
      let lo = start;
      let hi = last;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (estimateTokens(lines.slice(start - 1, mid).join('\n')) <= cap) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      last = Math.max(start, lo);
      text = `${lines.slice(start - 1, last).join('\n')}\n# ... truncated at L${last}; use read_file_range for L${last + 1}-${end}`;
      tokens = estimateTokens(text);
    }
    return { mention: raw, kind, path: rel, startLine: start, endLine: last, text, tokens, truncated };
  }
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) {
      i++;
      if (i === needle.length) {
        return true;
      }
    }
  }
  return needle.length === 0;
}
