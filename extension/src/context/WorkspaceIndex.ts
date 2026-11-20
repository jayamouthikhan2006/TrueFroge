import { type Chunk, chunkFile, type FileLanguage, pathTerms } from './chunker';
import { flattenSymbols, type PySymbol } from './PythonSymbolExtractor';
import { identifiersIn, splitIdentifier, stem } from './tokens';

export interface IndexedFile {
  path: string;
  language: FileLanguage;
  text: string;
  lineCount: number;
  chunks: Chunk[];
  symbols: PySymbol[];
  pathTerms: string[];
  version: number;
}

export interface SymbolHit {
  path: string;
  name: string;
  qualifiedName: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature: string;
  score: number;
}

interface ChunkStats {
  tf: Map<string, number>;
  length: number;
}

/** Text files worth indexing for code retrieval. */
export const INDEXED_EXTENSIONS = ['.py', '.pyi', '.rst', '.md', '.toml', '.cfg', '.ini', '.txt', '.yaml', '.yml', '.json', '.js', '.ts', '.html', '.jinja', '.j2'];
export const EXCLUDED_DIRS = [
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.tox',
  '.nox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'build',
  'dist',
  '.eggs',
  'htmlcov',
  '_build',
  'site-packages',
];
export const MAX_FILE_BYTES = 400_000;

export class WorkspaceIndex {
  private readonly files = new Map<string, IndexedFile>();
  private chunkStats = new Map<string, ChunkStats>();
  private documentFrequency = new Map<string, number>();
  private pathDocumentFrequency = new Map<string, number>();
  private totalChunks = 0;
  private averageChunkLength = 1;
  private statsDirty = true;
  private versionCounter = 0;
  builtAt = 0;

  get fileCount(): number {
    return this.files.size;
  }

  get chunkCount(): number {
    this.ensureStats();
    return this.totalChunks;
  }

  allFiles(): IterableIterator<IndexedFile> {
    return this.files.values();
  }

  getFile(path: string): IndexedFile | undefined {
    return this.files.get(normalizePath(path));
  }

  upsert(path: string, text: string): IndexedFile {
    const key = normalizePath(path);
    const outline = chunkFile(key, text);
    const file: IndexedFile = {
      path: key,
      language: outline.language,
      text,
      lineCount: text.split(/\r?\n/).length,
      chunks: outline.chunks,
      symbols: outline.symbols,
      pathTerms: pathTerms(key),
      version: ++this.versionCounter,
    };
    this.files.set(key, file);
    this.statsDirty = true;
    this.builtAt = Date.now();
    return file;
  }

  remove(path: string): void {
    if (this.files.delete(normalizePath(path))) {
      this.statsDirty = true;
    }
  }

  clear(): void {
    this.files.clear();
    this.statsDirty = true;
  }

  /** Inverse document frequency over chunks (BM25 variant, always positive). */
  idf(term: string): number {
    this.ensureStats();
    const df = this.documentFrequency.get(term) ?? 0;
    return Math.log(1 + (this.totalChunks - df + 0.5) / (df + 0.5));
  }

  /** IDF over file paths: how distinctive a path term is (`flask` ~0, `cli` high). */
  pathIdf(term: string): number {
    this.ensureStats();
    const df = this.pathDocumentFrequency.get(term) ?? 0;
    return Math.log(1 + (this.files.size - df + 0.5) / (df + 0.5));
  }

  /** BM25 (k1=1.2, b=0.75) of a chunk for weighted query terms. */
  bm25(chunk: Chunk, query: Map<string, number>): { score: number; matched: Array<{ term: string; contribution: number }> } {
    this.ensureStats();
    const stats = this.chunkStats.get(chunk.id);
    if (!stats) {
      return { score: 0, matched: [] };
    }
    const k1 = 1.2;
    const b = 0.75;
    let score = 0;
    const matched: Array<{ term: string; contribution: number }> = [];
    for (const [term, weight] of query) {
      const tf = stats.tf.get(term);
      if (!tf) {
        continue;
      }
      const norm = tf * (k1 + 1);
      const denom = tf + k1 * (1 - b + (b * stats.length) / this.averageChunkLength);
      const contribution = weight * this.idf(term) * (norm / denom);
      score += contribution;
      matched.push({ term, contribution });
    }
    matched.sort((a, b2) => b2.contribution - a.contribution);
    return { score, matched };
  }

  searchSymbols(query: string, kind: string | undefined, limit: number): SymbolHit[] {
    const q = query.trim().toLowerCase();
    if (q.length === 0) {
      return [];
    }
    const qParts = splitIdentifier(q).map(stem);
    const exactIds = identifiersIn(query);
    const hits: SymbolHit[] = [];
    for (const file of this.files.values()) {
      const candidates: Array<Omit<SymbolHit, 'score' | 'path'>> = [];
      if (file.language === 'python') {
        const lines = file.text.split(/\r?\n/);
        for (const symbol of flattenSymbols(file.symbols)) {
          candidates.push({
            name: symbol.name,
            qualifiedName: symbol.qualifiedName,
            kind: symbol.kind,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            signature: [...symbol.decorators, lines.slice(symbol.defLine - 1, symbol.signatureEndLine).map((l) => l.trim()).join(' ')].join(' '),
          });
        }
      } else {
        for (const chunk of file.chunks.filter((c) => c.kind === 'section')) {
          candidates.push({ name: chunk.name, qualifiedName: chunk.qualifiedName, kind: 'section', startLine: chunk.startLine, endLine: chunk.endLine, signature: chunk.qualifiedName });
        }
      }
      for (const candidate of candidates) {
        if (kind && kind !== 'any' && candidate.kind !== kind) {
          continue;
        }
        const name = candidate.name.toLowerCase();
        const qualified = candidate.qualifiedName.toLowerCase();
        let score = 0;
        if (name === q || qualified === q || exactIds.has(name)) {
          score = 1;
        } else if (name.startsWith(q) || qualified.endsWith(`.${q}`)) {
          score = 0.85;
        } else if (name.includes(q) || qualified.includes(q)) {
          score = 0.7;
        } else {
          const parts = new Set(splitIdentifier(candidate.qualifiedName).map(stem));
          const overlap = qParts.filter((p) => parts.has(p)).length;
          if (overlap > 0) {
            score = 0.5 * (overlap / qParts.length) + 0.1 * (overlap / parts.size);
          } else if (candidate.signature.toLowerCase().includes(q)) {
            score = 0.35;
          }
        }
        if (score > 0) {
          hits.push({ ...candidate, path: file.path, score });
        }
      }
    }
    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);
    return hits.slice(0, limit);
  }

  private ensureStats(): void {
    if (!this.statsDirty) {
      return;
    }
    const stats = new Map<string, ChunkStats>();
    const df = new Map<string, number>();
    const pathDf = new Map<string, number>();
    let totalLength = 0;
    let chunks = 0;
    for (const file of this.files.values()) {
      for (const term of file.pathTerms) {
        pathDf.set(term, (pathDf.get(term) ?? 0) + 1);
      }
      for (const chunk of file.chunks) {
        const tf = new Map<string, number>();
        // Name terms are counted twice: a term in a symbol name is stronger
        // evidence than one in its body.
        for (const term of chunk.bodyTerms) {
          tf.set(term, (tf.get(term) ?? 0) + 1);
        }
        for (const term of chunk.nameTerms) {
          tf.set(term, (tf.get(term) ?? 0) + 2);
        }
        for (const term of tf.keys()) {
          df.set(term, (df.get(term) ?? 0) + 1);
        }
        const length = chunk.bodyTerms.length + 2 * chunk.nameTerms.length;
        stats.set(chunk.id, { tf, length });
        totalLength += length;
        chunks++;
      }
    }
    this.chunkStats = stats;
    this.documentFrequency = df;
    this.pathDocumentFrequency = pathDf;
    this.totalChunks = chunks;
    this.averageChunkLength = chunks > 0 ? totalLength / chunks : 1;
    this.statsDirty = false;
  }
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

export function isIndexable(relPath: string): boolean {
  const normalized = normalizePath(relPath);
  const segments = normalized.split('/');
  if (segments.some((s) => EXCLUDED_DIRS.includes(s) || s.endsWith('.egg-info'))) {
    return false;
  }
  const lower = normalized.toLowerCase();
  return INDEXED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
