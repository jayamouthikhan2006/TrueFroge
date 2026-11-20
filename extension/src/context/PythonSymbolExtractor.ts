// Indentation-aware Python outline extractor. It is not a full parser, but it
// handles what matters for retrieval: decorators (including multi-line
// `@click.option(...)` stacks), multi-line signatures, docstrings, nested
// methods, triple-quoted strings that contain `def`, and module-level
// assignments such as `cli = FlaskGroup(...)`.

export type PySymbolKind = 'class' | 'function' | 'method' | 'variable';

export interface PySymbol {
  name: string;
  qualifiedName: string;
  kind: PySymbolKind;
  indent: number;
  /** 1-based line of the first decorator (or the def/class line). */
  startLine: number;
  /** 1-based line of the `def`/`class` keyword. */
  defLine: number;
  /** 1-based line where the signature's closing `:` is. */
  signatureEndLine: number;
  /** 1-based last line of the body (trailing blank lines excluded). */
  endLine: number;
  decorators: string[];
  docstring?: string;
  /** 1-based last line of the docstring, if any. */
  docstringEndLine?: number;
  parent?: string;
  children: PySymbol[];
}

interface LineInfo {
  text: string;
  indent: number;
  blank: boolean;
  /** Line is a comment or sits entirely inside a multi-line string/bracket continuation. */
  continuation: boolean;
  comment: boolean;
}

const DEF_RE = /^(\s*)(async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=(?!=)/;

/** Classifies lines, tracking triple-quoted strings and open brackets across lines. */
function scanLines(source: string): LineInfo[] {
  const lines = source.split(/\r?\n/);
  const out: LineInfo[] = [];
  let inString: '"""' | "'''" | null = null;
  let depth = 0;
  for (const text of lines) {
    const startedInside = inString !== null || depth > 0;
    const indent = /^[ \t]*/.exec(text)![0].replace(/\t/g, '    ').length;
    const trimmed = text.trim();
    let i = 0;
    while (i < text.length) {
      if (inString) {
        const close = text.indexOf(inString, i);
        if (close < 0) {
          i = text.length;
        } else {
          i = close + 3;
          inString = null;
        }
        continue;
      }
      const ch = text[i]!;
      if (ch === '#') {
        break;
      }
      if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
        inString = text.slice(i, i + 3) as '"""' | "'''";
        i += 3;
        continue;
      }
      if (ch === '"' || ch === "'") {
        // Single-line string literal: skip to its end, honouring escapes.
        let j = i + 1;
        while (j < text.length && text[j] !== ch) {
          j += text[j] === '\\' ? 2 : 1;
        }
        i = j + 1;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth = Math.max(0, depth - 1);
      }
      i++;
    }
    out.push({
      text,
      indent,
      blank: trimmed.length === 0,
      continuation: startedInside,
      comment: trimmed.startsWith('#'),
    });
  }
  return out;
}

function readDocstring(lines: LineInfo[], fromIndex: number): { text: string; endIndex: number } | undefined {
  let i = fromIndex;
  while (i < lines.length && (lines[i]!.blank || lines[i]!.comment)) {
    i++;
  }
  if (i >= lines.length) {
    return undefined;
  }
  const first = lines[i]!.text.trim();
  const match = /^([rRuUbBfF]{0,2})("""|''')/.exec(first);
  if (!match) {
    return undefined;
  }
  const quote = match[2]!;
  const afterOpen = first.slice(match[0].length);
  const closeSame = afterOpen.indexOf(quote);
  if (closeSame >= 0) {
    return { text: afterOpen.slice(0, closeSame).trim(), endIndex: i };
  }
  const parts = [afterOpen];
  for (let j = i + 1; j < lines.length; j++) {
    const text = lines[j]!.text;
    const close = text.indexOf(quote);
    if (close >= 0) {
      parts.push(text.slice(0, close));
      return { text: dedent(parts).trim(), endIndex: j };
    }
    parts.push(text);
  }
  return { text: dedent(parts).trim(), endIndex: lines.length - 1 };
}

function dedent(parts: string[]): string {
  const rest = parts.slice(1).filter((p) => p.trim().length > 0);
  const min = rest.reduce((m, p) => Math.min(m, /^\s*/.exec(p)![0].length), Number.POSITIVE_INFINITY);
  const cut = Number.isFinite(min) ? min : 0;
  return [parts[0]!.trim(), ...parts.slice(1).map((p) => p.slice(cut))].join('\n');
}

export function extractPythonSymbols(source: string): PySymbol[] {
  const lines = scanLines(source);
  const roots: PySymbol[] = [];
  const stack: PySymbol[] = [];
  let pendingDecorators: { start: number; texts: string[]; indent: number } | undefined;

  const closeSymbolsAt = (indent: number, lineIndex: number) => {
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
      const sym = stack.pop()!;
      sym.endLine = lastContentLine(lines, sym.signatureEndLine - 1, lineIndex - 1) + 1;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.blank || line.comment || line.continuation) {
      continue;
    }
    const trimmed = line.text.trim();

    if (trimmed.startsWith('@')) {
      // Decorators close any symbol at a deeper-or-equal indent.
      closeSymbolsAt(line.indent, pendingDecorators ? pendingDecorators.start - 1 : i);
      if (!pendingDecorators || pendingDecorators.indent !== line.indent) {
        pendingDecorators = { start: i + 1, texts: [], indent: line.indent };
      }
      // Join a multi-line decorator call into one string.
      let text = trimmed;
      let j = i + 1;
      while (j < lines.length && lines[j]!.continuation) {
        text += ` ${lines[j]!.text.trim()}`;
        j++;
      }
      pendingDecorators.texts.push(text.replace(/\s+/g, ' '));
      continue;
    }

    const def = DEF_RE.exec(line.text);
    if (def) {
      const startLine = pendingDecorators && pendingDecorators.indent === line.indent ? pendingDecorators.start : i + 1;
      closeSymbolsAt(line.indent, startLine - 1);
      const keyword = def[2]!;
      const name = def[3]!;
      const parent = stack[stack.length - 1];
      // Signature may span lines: it ends on the first line after which no bracket is open.
      let sigEnd = i;
      while (sigEnd + 1 < lines.length && lines[sigEnd + 1]!.continuation && !lines[sigEnd + 1]!.text.trim().startsWith('"""')) {
        sigEnd++;
      }
      const kind: PySymbolKind = keyword === 'class' ? 'class' : parent?.kind === 'class' ? 'method' : 'function';
      const symbol: PySymbol = {
        name,
        qualifiedName: parent ? `${parent.qualifiedName}.${name}` : name,
        kind,
        indent: line.indent,
        startLine,
        defLine: i + 1,
        signatureEndLine: sigEnd + 1,
        endLine: sigEnd + 1,
        decorators: pendingDecorators && pendingDecorators.indent === line.indent ? pendingDecorators.texts : [],
        parent: parent?.qualifiedName,
        children: [],
      };
      const doc = readDocstring(lines, sigEnd + 1);
      if (doc) {
        symbol.docstring = doc.text;
        symbol.docstringEndLine = doc.endIndex + 1;
      }
      pendingDecorators = undefined;
      if (parent) {
        parent.children.push(symbol);
      } else {
        roots.push(symbol);
      }
      stack.push(symbol);
      i = sigEnd;
      continue;
    }

    pendingDecorators = undefined;
    closeSymbolsAt(line.indent, i);

    if (line.indent === 0) {
      const assign = ASSIGN_RE.exec(trimmed);
      if (assign) {
        let end = i;
        while (end + 1 < lines.length && lines[end + 1]!.continuation) {
          end++;
        }
        roots.push({
          name: assign[1]!,
          qualifiedName: assign[1]!,
          kind: 'variable',
          indent: 0,
          startLine: i + 1,
          defLine: i + 1,
          signatureEndLine: i + 1,
          endLine: end + 1,
          decorators: [],
          children: [],
        });
        i = end;
      }
    }
  }
  closeSymbolsAt(0, lines.length);
  return roots;
}

/** Last non-blank, non-comment line index in [from, to]. */
function lastContentLine(lines: LineInfo[], from: number, to: number): number {
  for (let i = Math.min(to, lines.length - 1); i > from; i--) {
    const line = lines[i]!;
    if (!line.blank && !line.comment) {
      return i;
    }
  }
  return from;
}

export function flattenSymbols(symbols: PySymbol[]): PySymbol[] {
  const out: PySymbol[] = [];
  const walk = (list: PySymbol[]) => {
    for (const symbol of list) {
      out.push(symbol);
      walk(symbol.children);
    }
  };
  walk(symbols);
  return out;
}
