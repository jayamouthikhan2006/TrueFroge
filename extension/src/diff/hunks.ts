import { createPatch, diffArrays } from 'diff';

/**
 * A contiguous change against the base text. Line indices are 0-based into
 * the base line array; a pure insertion has `removed.length === 0` and is
 * inserted before `oldStart`.
 */
export interface Hunk {
  id: string;
  index: number;
  oldStart: number;
  removed: string[];
  added: string[];
  status: 'pending' | 'accepted' | 'rejected';
}

export interface SearchReplace {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  /** 1-based line near the intended match, used to pick one of several occurrences. */
  near_line?: number;
}

export function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function splitLines(text: string): string[] {
  return toLf(text).split('\n');
}

/** Base line array of an edit: a file that does not exist yet has no lines. */
export function baseLinesOf(baseText: string | null): string[] {
  return baseText === null ? [] : splitLines(baseText);
}

export function computeHunks(baseText: string, proposedText: string, idPrefix: string): Hunk[] {
  const changes = diffArrays(splitLines(baseText), splitLines(proposedText));
  const hunks: Hunk[] = [];
  let oldIndex = 0;
  let current: Hunk | undefined;
  const flush = () => {
    if (current) {
      hunks.push(current);
      current = undefined;
    }
  };
  for (const change of changes) {
    if (!change.added && !change.removed) {
      flush();
      oldIndex += change.value.length;
      continue;
    }
    current ??= { id: `${idPrefix}:${hunks.length}`, index: hunks.length, oldStart: oldIndex, removed: [], added: [], status: 'pending' };
    if (change.removed) {
      current.removed.push(...change.value);
      oldIndex += change.value.length;
    } else {
      current.added.push(...change.value);
    }
  }
  flush();
  return hunks;
}

/** Applies the hunks selected by `take` to the base lines; the others keep the base text. */
export function applyHunks(baseLines: string[], hunks: Hunk[], take: (hunk: Hunk) => boolean): string[] {
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of [...hunks].sort((a, b) => a.oldStart - b.oldStart)) {
    out.push(...baseLines.slice(cursor, hunk.oldStart));
    if (take(hunk)) {
      out.push(...hunk.added);
    } else {
      out.push(...hunk.removed);
    }
    cursor = hunk.oldStart + hunk.removed.length;
  }
  out.push(...baseLines.slice(cursor));
  return out;
}

export function unifiedDiff(path: string, baseText: string, proposedText: string): string {
  return createPatch(path, toLf(baseText), toLf(proposedText), 'current', 'proposed', { context: 3 });
}

export class EditApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditApplicationError';
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) {
      return count;
    }
    count++;
    from = at + needle.length;
  }
}

/**
 * Applies exact search/replace edits in order (LF-normalized). When an
 * `old_string` is not found verbatim, a match that only differs in trailing
 * whitespace per line is accepted if it is unique, because models routinely
 * drop trailing spaces.
 */
export function applySearchReplace(content: string, edits: SearchReplace[]): string {
  let text = toLf(content);
  edits.forEach((edit, i) => {
    const label = `edits[${i}]`;
    const oldString = toLf(edit.old_string);
    const newString = toLf(edit.new_string);
    if (oldString.length === 0) {
      throw new EditApplicationError(`${label}.old_string is empty; use new_content to create a file`);
    }
    if (oldString === newString) {
      throw new EditApplicationError(`${label} changes nothing (old_string equals new_string)`);
    }
    const count = countOccurrences(text, oldString);
    if (count === 1 || (count > 1 && edit.replace_all)) {
      text = edit.replace_all ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
      return;
    }
    if (count > 1) {
      const starts: number[] = [];
      for (let at = text.indexOf(oldString); at >= 0; at = text.indexOf(oldString, at + 1)) {
        starts.push(at);
      }
      const lineOf = (offset: number) => text.slice(0, offset).split('\n').length;
      if (typeof edit.near_line === 'number' && Number.isFinite(edit.near_line)) {
        const target = edit.near_line;
        const best = starts.reduce((a, b) => (Math.abs(lineOf(b) - target) < Math.abs(lineOf(a) - target) ? b : a));
        text = text.slice(0, best) + newString + text.slice(best + oldString.length);
        return;
      }
      throw new EditApplicationError(
        `${label}.old_string occurs ${count} times (at ${starts.map((s) => `L${lineOf(s)}`).join(', ')}); set near_line to the line you mean, include more surrounding lines so it is unique, or set replace_all`,
      );
    }
    const pattern = oldString
      .split('\n')
      .map((line) => `${escapeRegExp(line.replace(/[ \t]+$/, ''))}[ \\t]*`)
      .join('\\n');
    const matches = [...text.matchAll(new RegExp(pattern, 'g'))];
    if (matches.length === 1) {
      const m = matches[0]!;
      text = text.slice(0, m.index) + newString + text.slice(m.index + m[0].length);
      return;
    }
    const firstLine = oldString.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
    const near = firstLine ? text.split('\n').findIndex((l) => l.includes(firstLine)) : -1;
    throw new EditApplicationError(
      matches.length > 1
        ? `${label}.old_string matches ${matches.length} places after whitespace normalization; include more context`
        : `${label}.old_string was not found in the file${near >= 0 ? ` (its first line appears at L${near + 1}; re-read that range and copy it exactly)` : '; re-read the file with read_file_range and copy the text exactly'}`,
    );
  });
  return text;
}
