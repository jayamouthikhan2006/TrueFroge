// Token estimation and term extraction shared by the index, BM25 scorer and
// budget packer.

/**
 * Estimates BPE token count for source code and prose without shipping a
 * tokenizer. Calibrated against cl100k/o200k on Python and reStructuredText:
 * identifiers and words average ~1.3 tokens, punctuation runs are mostly one
 * token each, and leading indentation compresses to roughly one token per
 * four spaces. Errs slightly high so packed context never overruns the budget.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let tokens = 0;
  const lines = text.split('\n');
  for (const line of lines) {
    const indent = /^[ \t]*/.exec(line)![0].length;
    tokens += Math.ceil(indent / 4);
    const body = line.slice(indent);
    const words = body.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g);
    if (words) {
      for (const word of words) {
        tokens += word.length <= 4 ? 1 : Math.ceil(word.length / 4.5) + (/[a-z][A-Z]|_/.test(word) ? 1 : 0);
      }
    }
    const symbols = body.replace(/[A-Za-z0-9_\s]+/g, '');
    tokens += Math.ceil(symbols.length * 0.8);
    tokens += 1; // newline
  }
  return Math.max(1, Math.round(tokens * 1.05));
}

const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have how i if in into is it its ' +
    'it\'s me must my new no not of on or our out over own should so some such than that the their them then there ' +
    'these they this those to too under up us use used using was we were what when where which while who why will with ' +
    'would you your also any all each every other only well as just very make makes made add adds added get gets via ' +
    'self'
  ).split(/\s+/),
);

/** Splits snake_case, camelCase, dotted and path identifiers into lowercase parts. */
export function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

/** Light suffix stripping so "commands"/"command", "tested"/"test", "masking"/"mask" meet. */
export function stem(term: string): string {
  if (term.length <= 3) {
    return term;
  }
  if (term.endsWith('ies') && term.length > 4) {
    return `${term.slice(0, -3)}y`;
  }
  if (term.endsWith('ing') && term.length > 5) {
    return term.slice(0, -3);
  }
  if (term.endsWith('ed') && term.length > 4) {
    return term.slice(0, -2);
  }
  if (term.endsWith('es') && /(ss|sh|ch|x|z)es$/.test(term)) {
    return term.slice(0, -2);
  }
  if (term.endsWith('s') && !term.endsWith('ss') && !term.endsWith('us') && !term.endsWith('is')) {
    return term.slice(0, -1);
  }
  return term;
}

/** Terms used for BM25 and matching: identifier parts, stemmed, stopwords removed. */
export function terms(text: string): string[] {
  const out: string[] = [];
  const raw = text.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  if (!raw) {
    return out;
  }
  for (const token of raw) {
    for (const part of splitIdentifier(token)) {
      if (part.length < 2 || STOPWORDS.has(part) || /^\d+$/.test(part)) {
        continue;
      }
      out.push(stem(part));
    }
  }
  return out;
}

/** Whole identifiers mentioned verbatim in a query, e.g. `get_debug_flag`, `FlaskGroup`. */
export function identifiersIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)) {
    const id = match[0];
    if (id.includes('_') || /[a-z][A-Z]/.test(id) || id.includes('.')) {
      found.add(id.toLowerCase());
      const last = id.split('.').pop();
      if (last) {
        found.add(last.toLowerCase());
      }
    }
  }
  return found;
}
