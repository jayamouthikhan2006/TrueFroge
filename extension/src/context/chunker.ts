import { extractPythonSymbols, flattenSymbols, type PySymbol } from './PythonSymbolExtractor';
import { estimateTokens, splitIdentifier, stem, terms } from './tokens';

export type ChunkKind = 'function' | 'class' | 'method' | 'variable' | 'module' | 'section' | 'block';

export interface Chunk {
  id: string;
  path: string;
  kind: ChunkKind;
  name: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  text: string;
  /** Compact view used when the budget cannot afford `text`: decorators, signature, docstring. */
  signature: string;
  tokens: number;
  signatureTokens: number;
  decorators: string[];
  /** Stemmed terms of the chunk's name, qualified name, decorators and heading path. */
  nameTerms: string[];
  /** Stemmed body terms for BM25. */
  bodyTerms: string[];
}

export type FileLanguage = 'python' | 'rst' | 'markdown' | 'text';

export interface FileOutline {
  language: FileLanguage;
  chunks: Chunk[];
  symbols: PySymbol[];
}

export function languageOf(path: string): FileLanguage {
  const lower = path.toLowerCase();
  if (lower.endsWith('.py') || lower.endsWith('.pyi')) {
    return 'python';
  }
  if (lower.endsWith('.rst')) {
    return 'rst';
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return 'markdown';
  }
  return 'text';
}

const MAX_BLOCK_LINES = 80;

export function chunkFile(path: string, text: string): FileOutline {
  const language = languageOf(path);
  const lines = text.split(/\r?\n/);
  if (language === 'python') {
    return chunkPython(path, lines, text);
  }
  if (language === 'rst' || language === 'markdown') {
    return { language, chunks: chunkSections(path, lines, language), symbols: [] };
  }
  return { language, chunks: chunkBlocks(path, lines, 'block', 1, lines.length, 'lines'), symbols: [] };
}

function makeChunk(
  path: string,
  kind: ChunkKind,
  name: string,
  qualifiedName: string,
  startLine: number,
  endLine: number,
  text: string,
  signature: string,
  decorators: string[],
  extraNameText = '',
): Chunk {
  const nameTerms = [...new Set(terms(`${qualifiedName} ${decorators.map(decoratorHead).join(' ')} ${extraNameText}`))];
  return {
    id: `${path}#${startLine}-${endLine}`,
    path,
    kind,
    name,
    qualifiedName,
    startLine,
    endLine,
    text,
    signature,
    tokens: estimateTokens(text),
    signatureTokens: estimateTokens(signature),
    decorators,
    nameTerms,
    bodyTerms: terms(text),
  };
}

function slice(lines: string[], start: number, end: number): string {
  return lines.slice(start - 1, end).join('\n');
}

function pySignature(lines: string[], symbol: PySymbol): string {
  const end = symbol.docstringEndLine ?? symbol.signatureEndLine;
  // Decorator stacks (e.g. ten @click.option(...) calls) are condensed to
  // their heads; the def line(s) and docstring are kept verbatim.
  const pad = ' '.repeat(symbol.indent);
  const decorators = symbol.decorators.map((d) => `${pad}${condensedDecorator(d)}`);
  let text = [...decorators, slice(lines, symbol.defLine, end)].join('\n');
  if (symbol.endLine > end) {
    text += `\n${' '.repeat(symbol.indent + 4)}...`;
  }
  return text;
}

function chunkPython(path: string, lines: string[], source: string): FileOutline {
  const symbols = extractPythonSymbols(source);
  const chunks: Chunk[] = [];
  const covered: Array<[number, number]> = [];

  for (const symbol of symbols) {
    if (symbol.kind === 'variable') {
      continue;
    }
    covered.push([symbol.startLine, symbol.endLine]);
    if (symbol.kind === 'class' && symbol.children.length > 0) {
      // Class chunk: header, docstring and class attributes, then an outline of
      // method signatures. Methods are chunks of their own.
      const firstMethod = symbol.children.reduce((m, c) => Math.min(m, c.startLine), Number.POSITIVE_INFINITY);
      const head = slice(lines, symbol.startLine, Math.max(symbol.signatureEndLine, firstMethod - 1)).replace(/\s+$/, '');
      const outline = symbol.children
        .map((child) => {
          const sig = slice(lines, child.startLine, child.signatureEndLine)
            .split('\n')
            .map((l) => l.trim())
            .join(' ');
          return `${' '.repeat(child.indent)}${sig}  # L${child.defLine}-${child.endLine}`;
        })
        .join('\n');
      const text = `${head}\n${outline}`;
      chunks.push(makeChunk(path, 'class', symbol.name, symbol.qualifiedName, symbol.startLine, symbol.endLine, text, pySignature(lines, symbol), symbol.decorators));
      for (const method of flattenSymbols(symbol.children)) {
        if (method.parent !== symbol.qualifiedName) {
          continue; // nested defs inside methods stay inside their method chunk
        }
        chunks.push(
          makeChunk(path, 'method', method.name, method.qualifiedName, method.startLine, method.endLine, slice(lines, method.startLine, method.endLine), pySignature(lines, method), method.decorators),
        );
      }
      continue;
    }
    const text = slice(lines, symbol.startLine, symbol.endLine);
    chunks.push(makeChunk(path, symbol.kind, symbol.name, symbol.qualifiedName, symbol.startLine, symbol.endLine, text, pySignature(lines, symbol), symbol.decorators));
  }

  // Module-level code between definitions (imports, registrations, `cli = FlaskGroup(...)`).
  covered.sort((a, b) => a[0] - b[0]);
  let cursor = 1;
  const gaps: Array<[number, number]> = [];
  for (const [start, end] of covered) {
    if (start > cursor) {
      gaps.push([cursor, start - 1]);
    }
    cursor = Math.max(cursor, end + 1);
  }
  if (cursor <= lines.length) {
    gaps.push([cursor, lines.length]);
  }
  const variables = symbols.filter((s) => s.kind === 'variable');
  for (const [start, end] of gaps) {
    let s = start;
    let e = end;
    while (s <= e && lines[s - 1]!.trim() === '') s++;
    while (e >= s && lines[e - 1]!.trim() === '') e--;
    if (s > e) {
      continue;
    }
    for (const block of chunkBlocks(path, lines, 'module', s, e, s === 1 ? 'module header' : 'module-level')) {
      const names = variables.filter((v) => v.startLine >= block.startLine && v.startLine <= block.endLine).map((v) => v.name);
      if (names.length > 0) {
        block.name = names.join(', ');
        block.qualifiedName = block.name;
        block.nameTerms = [...new Set([...block.nameTerms, ...terms(block.name)])];
      }
      chunks.push(block);
    }
  }
  chunks.sort((a, b) => a.startLine - b.startLine);
  return { language: 'python', chunks, symbols };
}

function chunkBlocks(path: string, lines: string[], kind: ChunkKind, start: number, end: number, label: string): Chunk[] {
  const out: Chunk[] = [];
  for (let s = start; s <= end; s += MAX_BLOCK_LINES) {
    const e = Math.min(end, s + MAX_BLOCK_LINES - 1);
    const text = slice(lines, s, e);
    if (text.trim().length === 0) {
      continue;
    }
    const signature = lines
      .slice(s - 1, e)
      .filter((l) => l.trim().length > 0)
      .slice(0, 6)
      .join('\n');
    const name = `${label} L${s}-${e}`;
    out.push(makeChunk(path, kind, name, name, s, e, text, `${signature}\n...`, []));
  }
  return out;
}

const RST_UNDERLINE = /^([=\-~^"'`#*+:.])\1{2,}\s*$/;

interface Heading {
  line: number;
  title: string;
  level: number;
}

function findHeadings(lines: string[], language: FileLanguage): Heading[] {
  const headings: Heading[] = [];
  if (language === 'markdown') {
    let fence = false;
    lines.forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fence = !fence;
      }
      const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) {
        headings.push({ line: i + 1, title: m[2]!, level: m[1]!.length });
      }
    });
    return headings;
  }
  // reStructuredText: a title line followed by an adornment line at least as
  // long; adornment characters are assigned levels in order of first use.
  const levels: string[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const title = lines[i]!;
    const under = lines[i + 1]!;
    if (title.trim().length === 0 || /^\s/.test(title) || RST_UNDERLINE.test(title)) {
      continue;
    }
    const m = RST_UNDERLINE.exec(under);
    if (!m || under.trim().length < title.trim().length) {
      continue;
    }
    const over = i > 0 && RST_UNDERLINE.test(lines[i - 1]!) ? `over${m[1]}` : m[1]!;
    let level = levels.indexOf(over);
    if (level < 0) {
      levels.push(over);
      level = levels.length - 1;
    }
    headings.push({ line: i > 0 && over.startsWith('over') ? i : i + 1, title: title.trim(), level: level + 1 });
    i++;
  }
  return headings;
}

function chunkSections(path: string, lines: string[], language: FileLanguage): Chunk[] {
  const headings = findHeadings(lines, language);
  if (headings.length === 0) {
    return chunkBlocks(path, lines, 'block', 1, lines.length, 'lines');
  }
  const chunks: Chunk[] = [];
  if (headings[0]!.line > 1) {
    chunks.push(...chunkBlocks(path, lines, 'block', 1, headings[0]!.line - 1, 'preamble'));
  }
  const trail: Heading[] = [];
  headings.forEach((heading, idx) => {
    while (trail.length > 0 && trail[trail.length - 1]!.level >= heading.level) {
      trail.pop();
    }
    trail.push(heading);
    const end = (headings[idx + 1]?.line ?? lines.length + 1) - 1;
    const text = slice(lines, heading.line, end).replace(/\s+$/, '');
    if (text.trim().length === 0) {
      return;
    }
    const crumb = trail.map((h) => h.title).join(' > ');
    const firstPara = text.split(/\n\s*\n/).slice(0, 2).join('\n\n');
    const sectionLines = text.split('\n').length;
    if (sectionLines > MAX_BLOCK_LINES * 2) {
      // Very long sections are split so retrieval can pick the relevant part.
      for (const block of chunkBlocks(path, lines, 'section', heading.line, end, heading.title)) {
        block.qualifiedName = `${crumb} (${block.name})`;
        block.nameTerms = [...new Set([...block.nameTerms, ...terms(crumb)])];
        chunks.push(block);
      }
      return;
    }
    chunks.push(makeChunk(path, 'section', heading.title, crumb, heading.line, end, text, `${firstPara}\n...`, [], crumb));
  });
  return chunks;
}

/**
 * The identifying part of a decorator: its callable plus the first string
 * argument, e.g. `@click.command("routes", short_help=...)` → `@click.command("routes")`.
 * Option lists and help texts are left to BM25.
 */
export function decoratorHead(decorator: string): string {
  const m = /^@([\w.]+)(?:\(\s*(?:[rbuf]?)(["'])([^"']*)\2)?/.exec(decorator.trim());
  if (!m) {
    return decorator.trim().split('(')[0]!;
  }
  return m[3] !== undefined ? `@${m[1]}("${m[3]}")` : `@${m[1]}`;
}

/** `@click.option("--host", "-h", default=...)` → `@click.option("--host", ...)`; short decorators unchanged. */
function condensedDecorator(decorator: string): string {
  const full = decorator.trim();
  const head = decoratorHead(full);
  if (full === head || full.length <= 60) {
    return full;
  }
  return head.endsWith(')') ? `${head.slice(0, -1)}, ...)` : `${head}(...)`;
}

/** Path terms, e.g. `tests/test_cli.py` → [test, cli, py]. Directory names count too. */
export function pathTerms(path: string): string[] {
  return [...new Set(splitIdentifier(path).filter((p) => p.length > 1).map(stem))];
}
