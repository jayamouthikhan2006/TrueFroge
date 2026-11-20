import { randomUUID } from 'node:crypto';
import { type Chunk, decoratorHead, pathTerms } from './chunker';
import { estimateTokens, identifiersIn, stem, terms } from './tokens';
import { type IndexedFile, normalizePath, type WorkspaceIndex } from './WorkspaceIndex';

export const SCORE_WEIGHTS = { symbol: 0.5, bm25: 0.3, path: 0.2 } as const;

export interface RetrievalRequest {
  query: string;
  budgetTokens: number;
  /** Workspace-relative paths that should rank higher (explicit @file mentions, the active file). */
  focusPaths?: string[];
  /** Paths whose content the user already attached; they are pinned into the manifest but not re-packed. */
  attachedPaths?: string[];
  /** Tokens already spent on explicitly attached context this turn. */
  explicitTokens?: number;
}

export interface ScoreComponents {
  symbol: number;
  bm25: number;
  path: number;
}

export interface ManifestChunk {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  mode: 'full' | 'signature';
  tokens: number;
  score: number;
}

export interface ManifestFile {
  path: string;
  score: number;
  components: ScoreComponents;
  tokens: number;
  mode: 'full' | 'mixed' | 'signatures';
  reason: string;
  chunks: ManifestChunk[];
}

export interface ManifestCandidate {
  path: string;
  score: number;
  selected: boolean;
  reason: string;
}

export interface ContextManifest {
  id: string;
  query: string;
  strategy: string;
  budget: { limit: number; explicit: number; retrieved: number; used: number; remaining: number };
  index: { files: number; chunks: number };
  filesConsidered: number;
  filesSelected: number;
  selected: ManifestFile[];
  candidates: ManifestCandidate[];
  pruned: Array<{ path: string; chunk?: string; reason: string }>;
  elapsedMs: number;
  createdAt: string;
}

export interface RetrievalResult {
  manifest: ContextManifest;
  /** The packed context, ready to hand to the model. */
  context: string;
}

interface ScoredChunk {
  chunk: Chunk;
  file: IndexedFile;
  score: number;
  components: ScoreComponents;
  matchedNameTerms: string[];
  matchedBodyTerms: string[];
  /** Top-matched symbols this chunk references (registration/usage sites). */
  references: string[];
}

interface QueryModel {
  raw: string;
  weights: Map<string, number>;
  identifiers: Set<string>;
  wantsTests: boolean;
  wantsDocs: boolean;
  totalIdf: number;
}

// Generic software-engineering synonyms; expansions carry half weight.
const SYNONYMS: Record<string, string[]> = {
  cli: ['command', 'click'],
  command: ['cli', 'click'],
  config: ['configuration', 'setting'],
  configuration: ['config'],
  setting: ['config'],
  error: ['exception', 'raise'],
  exception: ['error'],
  route: ['rule', 'url'],
  url: ['route', 'rule'],
  env: ['environ', 'environment'],
  environment: ['environ', 'env'],
  json: ['dump', 'serialize'],
  debug: ['debugger'],
  template: ['jinja', 'render'],
  request: ['req'],
  response: ['resp'],
};

const TEST_INTENT = /\b(tests?|tested|testing|pytest|unit[- ]tests?|covered|coverage|spec)\b/i;
/** Stemmed deliverable words removed from content matching (see buildQuery). */
const INTENT_TERMS = ['test', 'pytest', 'unit', 'cover', 'coverage', 'spec', 'doc', 'document', 'documentation', 'readme', 'changelog'];
const DOC_INTENT = /\b(docs?|documented|document|documentation|readme|guide|changelog|rst)\b/i;
const GENERIC_PATH_TERMS = new Set(['src', 'py', 'pyi', 'rst', 'md', 'txt', 'lib', 'init', 'main', 'index', 'json', 'toml', 'cfg']);

const RELEVANCE_FLOOR = 0.3; // fraction of the best file score a file needs to be packed
const SIGNATURE_ONLY_BELOW = 0.55; // chunks under this fraction of the best chunk score are packed as signatures
const MAX_FILES = 8;
const MAX_CHUNK_SHARE = 0.2; // a single chunk may use at most this share of the budget in full
const MAX_FILE_SHARE = 0.4; // after a file has used this share, its further chunks are signatures
const MANIFEST_CANDIDATES = 20;

export class ContextEngine {
  private last: ContextManifest | undefined;

  constructor(private readonly index: WorkspaceIndex) {}

  get lastManifest(): ContextManifest | undefined {
    return this.last;
  }

  retrieve(request: RetrievalRequest): RetrievalResult {
    const started = Date.now();
    const explicit = Math.max(0, request.explicitTokens ?? 0);
    // Explicit attachments come out of the same budget, but retrieval always keeps a quarter of it.
    const retrievalBudget = Math.max(Math.floor(request.budgetTokens * 0.25), request.budgetTokens - explicit);
    const query = this.buildQuery(request.query);
    const focus = (request.focusPaths ?? []).map(normalizePath);
    const attached = new Set((request.attachedPaths ?? []).map(normalizePath));

    const scored = this.scoreChunks(query, focus);
    const byFile = new Map<string, ScoredChunk[]>();
    for (const item of scored) {
      const list = byFile.get(item.file.path) ?? [];
      list.push(item);
      byFile.set(item.file.path, list);
    }
    const fileScores = [...byFile.entries()]
      .map(([path, chunks]) => {
        chunks.sort((a, b) => b.score - a.score);
        const best = chunks[0]!.score;
        const second = chunks[1]?.score ?? 0;
        // Facet coverage: how much of the query (IDF-weighted) the file as a
        // whole answers, so a file matching many aspects beats one that
        // matches a single term very well.
        const covered = new Set(chunks.flatMap((c) => [...c.matchedNameTerms, ...c.matchedBodyTerms]));
        let coveredIdf = 0;
        for (const [term, weight] of query.weights) {
          if (covered.has(term)) {
            coveredIdf += weight * this.index.idf(term);
          }
        }
        const coverage = Math.min(1, (1.5 * coveredIdf) / query.totalIdf);
        const score = 0.75 * Math.min(1, best + 0.15 * second) + 0.25 * coverage;
        return { path, chunks, score, category: categoryOf(path) };
      })
      .sort((a, b) => b.score - a.score);

    const topFileScore = fileScores[0]?.score ?? 0;
    const topChunkScore = scored[0]?.score ?? 0;
    const pruned: ContextManifest['pruned'] = [];

    // Facet leaders: the best source file always, plus the best test and doc
    // file when the task asks for tests/docs. They are packed first so one
    // facet (e.g. many similar test files) cannot crowd out the others.
    // Test/doc leaders are chosen by score plus affinity to the source leader
    // (cli.py ↔ test_cli.py ↔ cli.rst): tests and docs for a module usually
    // live next to its name.
    const sourceLeader = fileScores.find((f) => f.category === 'source' && !attached.has(f.path));
    const affinity = (path: string) => (sourceLeader ? proximity(path, sourceLeader.path) : 0);
    const leaderFor = (category: FileCategory) =>
      fileScores
        .filter((f) => f.category === category && !attached.has(f.path))
        .slice(0, 12)
        .sort((a, b) => b.score + 0.3 * affinity(b.path) - (a.score + 0.3 * affinity(a.path)))[0];
    const leaders = [sourceLeader, ...(query.wantsTests ? [leaderFor('test')] : []), ...(query.wantsDocs ? [leaderFor('doc')] : [])].filter(
      (f): f is (typeof fileScores)[number] => f !== undefined && f.score >= 0.5 * RELEVANCE_FLOOR * topFileScore,
    );
    const pairedWithLeader = new Set(leaders.filter((f) => f !== sourceLeader && affinity(f.path) >= 0.7).map((f) => f.path));
    const ordered = [...leaders, ...fileScores.filter((f) => !leaders.includes(f))];
    const eligible = ordered.filter((f, i) => {
      if (attached.has(f.path)) {
        return false;
      }
      const keep = i < MAX_FILES && (leaders.includes(f) || f.score >= RELEVANCE_FLOOR * topFileScore);
      if (!keep && i < MANIFEST_CANDIDATES) {
        pruned.push({
          path: f.path,
          reason: i >= MAX_FILES ? `ranked #${i + 1}; only the top ${MAX_FILES} files are packed` : `score ${f.score.toFixed(2)} below relevance floor ${(RELEVANCE_FLOOR * topFileScore).toFixed(2)}`,
        });
      }
      return keep;
    });

    // Greedy packing. Pass 1 guarantees coverage (best chunk of each top file),
    // pass 2 fills the remaining budget in global score order.
    const header = 'Retrieved workspace context (ranked; line ranges are 1-based).\n';
    let used = estimateTokens(header);
    const packed = new Map<string, Array<{ item: ScoredChunk; mode: 'full' | 'signature'; tokens: number }>>();
    const taken = new Set<string>();
    const fileHeaderTokens = 24;

    const fileUsage = new Map<string, number>();
    const tryPack = (item: ScoredChunk, allowFull: boolean): boolean => {
      if (taken.has(item.chunk.id)) {
        return false;
      }
      const isNewFile = !packed.has(item.file.path);
      const overhead = isNewFile ? fileHeaderTokens : 8;
      // Caps keep one huge function or one file from starving the other facets.
      const oversized = item.chunk.tokens > MAX_CHUNK_SHARE * retrievalBudget && item !== scored[0];
      const fileFull = (fileUsage.get(item.file.path) ?? 0) > MAX_FILE_SHARE * retrievalBudget;
      const lowPriority = item.score < SIGNATURE_ONLY_BELOW * topChunkScore || oversized || fileFull;
      const fullCost = item.chunk.tokens + overhead;
      const sigCost = item.chunk.signatureTokens + overhead;
      let mode: 'full' | 'signature' | undefined;
      if (allowFull && !lowPriority && used + fullCost <= retrievalBudget) {
        mode = 'full';
      } else if (used + sigCost <= retrievalBudget && item.chunk.signatureTokens < item.chunk.tokens) {
        mode = 'signature';
      } else if (used + fullCost <= retrievalBudget && item.chunk.tokens <= item.chunk.signatureTokens) {
        mode = 'full';
      }
      if (!mode) {
        return false;
      }
      const tokens = mode === 'full' ? item.chunk.tokens : item.chunk.signatureTokens;
      used += tokens + overhead;
      fileUsage.set(item.file.path, (fileUsage.get(item.file.path) ?? 0) + tokens + overhead);
      taken.add(item.chunk.id);
      const list = packed.get(item.file.path) ?? [];
      list.push({ item, mode, tokens });
      packed.set(item.file.path, list);
      return true;
    };

    for (const file of eligible.slice(0, MAX_FILES)) {
      const best = file.chunks[0]!;
      if (!tryPack(best, true)) {
        pruned.push({ path: file.path, chunk: best.chunk.qualifiedName, reason: `budget exhausted (${used}/${retrievalBudget} tokens) before coverage pass reached this file` });
      }
    }
    const eligiblePaths = new Set(eligible.map((f) => f.path));
    const remaining = scored.filter((s) => eligiblePaths.has(s.file.path) && !taken.has(s.chunk.id));
    let budgetMisses = 0;
    for (const item of remaining) {
      if (item.score < 0.2 * topChunkScore) {
        break;
      }
      if (!tryPack(item, true)) {
        budgetMisses++;
        if (budgetMisses <= 6) {
          pruned.push({ path: item.file.path, chunk: item.chunk.qualifiedName, reason: `does not fit the remaining budget (${retrievalBudget - used} tokens left; needs ${item.chunk.signatureTokens}+)` });
        }
      }
    }

    const selected: ManifestFile[] = [];
    const blocks: string[] = [header];
    const selectedFiles = fileScores.filter((f) => packed.has(f.path));
    for (const file of selectedFiles) {
      const entries = packed.get(file.path)!.sort((a, b) => a.item.chunk.startLine - b.item.chunk.startLine);
      const best = file.chunks[0]!;
      const modes = new Set(entries.map((e) => e.mode));
      const mode: ManifestFile['mode'] = modes.size > 1 ? 'mixed' : modes.has('full') ? 'full' : 'signatures';
      const reason = this.explain(file.path, file.chunks, query, focus, pairedWithLeader.has(file.path) ? sourceLeader?.path : undefined);
      selected.push({
        path: file.path,
        score: round(file.score),
        components: { symbol: round(best.components.symbol), bm25: round(best.components.bm25), path: round(best.components.path) },
        tokens: entries.reduce((sum, e) => sum + e.tokens, 0),
        mode,
        reason,
        chunks: entries.map((e) => ({
          name: e.item.chunk.qualifiedName,
          kind: e.item.chunk.kind,
          startLine: e.item.chunk.startLine,
          endLine: e.item.chunk.endLine,
          mode: e.mode,
          tokens: e.tokens,
          score: round(e.item.score),
        })),
      });
      const fence = this.index.getFile(file.path)?.language === 'python' ? 'python' : this.index.getFile(file.path)?.language === 'rst' ? 'rst' : '';
      blocks.push(`### ${file.path} — ${reason}`);
      for (const entry of entries) {
        const c = entry.item.chunk;
        const label = entry.mode === 'full' ? `L${c.startLine}-${c.endLine}` : `L${c.startLine}-${c.endLine} (signature only; read_file_range for the body)`;
        blocks.push(`\`\`\`${fence}\n# ${label}: ${c.qualifiedName}\n${entry.mode === 'full' ? c.text : c.signature}\n\`\`\``);
      }
    }

    const candidates: ManifestCandidate[] = fileScores.slice(0, MANIFEST_CANDIDATES).map((f) => ({
      path: f.path,
      score: round(f.score),
      selected: packed.has(f.path),
      reason: attached.has(f.path) ? 'attached explicitly by the user (@file/@symbol)' : this.explain(f.path, f.chunks, query, focus),
    }));
    for (const path of attached) {
      if (!candidates.some((c) => c.path === path)) {
        candidates.unshift({ path, score: 1, selected: true, reason: 'attached explicitly by the user (@file/@symbol)' });
      }
    }

    const manifest: ContextManifest = {
      id: randomUUID(),
      query: request.query,
      strategy: `hybrid ${SCORE_WEIGHTS.symbol}·symbol_match + ${SCORE_WEIGHTS.bm25}·bm25 + ${SCORE_WEIGHTS.path}·path_proximity; greedy pack, low-priority chunks as signatures`,
      budget: { limit: request.budgetTokens, explicit, retrieved: used, used: used + explicit, remaining: Math.max(0, request.budgetTokens - used - explicit) },
      index: { files: this.index.fileCount, chunks: this.index.chunkCount },
      filesConsidered: fileScores.length,
      filesSelected: selected.length,
      selected,
      candidates,
      pruned,
      elapsedMs: Date.now() - started,
      createdAt: new Date().toISOString(),
    };
    this.last = manifest;
    return { manifest, context: blocks.join('\n\n') };
  }

  private buildQuery(raw: string): QueryModel {
    const weights = new Map<string, number>();
    for (const term of terms(raw)) {
      weights.set(term, 1);
    }
    // The head clause of an instruction ("Add a new built-in CLI command ...",
    // before "that"/"which"/punctuation) names the artifact to work on; the
    // rest describes behaviour. Head terms count double.
    for (const term of terms(headClause(raw))) {
      weights.set(term, 2);
    }
    for (const term of [...weights.keys()]) {
      for (const syn of SYNONYMS[term] ?? []) {
        const s = stem(syn);
        if (!weights.has(s)) {
          weights.set(s, 0.5);
        }
      }
    }
    const wantsTests = TEST_INTENT.test(raw);
    const wantsDocs = DOC_INTENT.test(raw);
    // "covered by a test", "documented": these name deliverables, not the
    // subject. They drive the test/doc facets (path bonus + facet leaders)
    // and must not make e.g. src/flask/testing.py look like the subject.
    for (const term of INTENT_TERMS) {
      weights.delete(term);
    }
    let totalIdf = 0;
    for (const [term, weight] of weights) {
      totalIdf += weight * this.index.idf(term);
    }
    return { raw, weights, identifiers: identifiersIn(raw), wantsTests, wantsDocs, totalIdf: Math.max(totalIdf, 1e-6) };
  }

  private scoreChunks(query: QueryModel, focus: string[]): ScoredChunk[] {
    const raw: Array<Omit<ScoredChunk, 'score' | 'components' | 'references'> & { symbol: number; bm25: number; path: number }> = [];
    let maxBm25 = 0;
    const pathCache = new Map<string, number>();
    for (const file of this.index.allFiles()) {
      let path = pathCache.get(file.path);
      if (path === undefined) {
        path = this.pathProximity(file, query, focus);
        pathCache.set(file.path, path);
      }
      for (const chunk of file.chunks) {
        const bm = this.index.bm25(chunk, query.weights);
        const { score: symbol, matched } = this.symbolMatch(chunk, query);
        if (bm.score === 0 && symbol === 0) {
          continue;
        }
        maxBm25 = Math.max(maxBm25, bm.score);
        raw.push({ chunk, file, symbol, bm25: bm.score, path, matchedNameTerms: matched, matchedBodyTerms: bm.matched.slice(0, 5).map((m) => m.term) });
      }
    }
    const combine = (c: ScoreComponents) => SCORE_WEIGHTS.symbol * c.symbol + SCORE_WEIGHTS.bm25 * c.bm25 + SCORE_WEIGHTS.path * c.path;
    const scored: ScoredChunk[] = raw
      .map((r) => {
        const components = { symbol: r.symbol, bm25: maxBm25 > 0 ? r.bm25 / maxBm25 : 0, path: r.path };
        return { chunk: r.chunk, file: r.file, score: combine(components), components, matchedNameTerms: r.matchedNameTerms, matchedBodyTerms: r.matchedBodyTerms, references: [] };
      })
      .sort((a, b) => b.score - a.score);

    // Reference signal: a chunk that names several of the strongest symbol
    // matches (e.g. `self.add_command(routes_command)` in FlaskGroup.__init__)
    // is where those symbols are registered or wired up.
    const anchors = scored
      .filter((s) => s.components.symbol >= 0.7 && (s.chunk.kind === 'function' || s.chunk.kind === 'class' || s.chunk.kind === 'method') && s.chunk.name.length > 3)
      .slice(0, 8);
    const anchorIds = new Set(anchors.map((a) => a.chunk.id));
    const anchorPatterns = anchors.map((a) => ({ name: a.chunk.name, re: new RegExp(`\\b${a.chunk.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) }));
    let changed = false;
    for (const item of scored) {
      if (anchorIds.has(item.chunk.id)) {
        continue;
      }
      const refs = anchorPatterns.filter((p) => p.re.test(item.chunk.text)).map((p) => p.name);
      const unique = [...new Set(refs)];
      if (unique.length >= 2) {
        item.references = unique;
        item.components.symbol = Math.max(item.components.symbol, Math.min(0.9, 0.6 + 0.1 * unique.length));
        item.score = combine(item.components);
        changed = true;
      }
    }
    return changed ? scored.sort((a, b) => b.score - a.score) : scored;
  }

  /** How strongly the chunk's identity (name, decorators, heading) matches the query, IDF-weighted. */
  private symbolMatch(chunk: Chunk, query: QueryModel): { score: number; matched: string[] } {
    const name = chunk.name.toLowerCase();
    if (query.identifiers.has(name) || query.identifiers.has(chunk.qualifiedName.toLowerCase())) {
      return { score: 1, matched: [chunk.name] };
    }
    if (chunk.nameTerms.length === 0) {
      return { score: 0, matched: [] };
    }
    // A decorator whose callable matches the head clause marks the chunk as an
    // existing instance of the artifact being worked on (e.g. "add a CLI
    // command" ↔ `@click.command("routes")`): exactly the exemplars to copy.
    let decoratorScore = 0;
    const decoratorMatches: string[] = [];
    for (const deco of chunk.decorators) {
      const callable = decoratorHead(deco).split('(')[0]!;
      const callTerms = terms(callable);
      const strongest = callTerms.reduce((max, t) => Math.max(max, query.weights.get(t) ?? 0), 0);
      if (strongest >= 2) {
        decoratorScore = Math.max(decoratorScore, 0.85);
        decoratorMatches.push(callable);
      } else if (strongest >= 1) {
        decoratorScore = Math.max(decoratorScore, 0.5);
        decoratorMatches.push(callable);
      }
    }
    // An identifier quoted verbatim in the query (FLASK_DEBUG, SECRET_KEY)
    // appearing in the chunk is strong evidence even if the name differs.
    let verbatimScore = 0;
    const lowerText = chunk.text.toLowerCase();
    for (const id of query.identifiers) {
      if (id.length >= 6 && lowerText.includes(id)) {
        verbatimScore = 0.75;
        decoratorMatches.push(id);
        break;
      }
    }
    let weightedIdf = 0; // query-weighted, for query coverage
    let rawIdf = 0; // unweighted, for name coverage and strength
    let nameIdf = 0;
    const matched: string[] = [];
    for (const term of chunk.nameTerms) {
      const idf = this.index.idf(term);
      nameIdf += idf;
      const weight = query.weights.get(term);
      if (weight !== undefined) {
        weightedIdf += weight * idf;
        rawIdf += Math.min(1, weight) * idf;
        matched.push(term);
      }
    }
    const evidence = Math.max(decoratorScore, verbatimScore);
    if (matched.length === 0) {
      return { score: evidence, matched: decoratorMatches };
    }
    const nameCoverage = rawIdf / Math.max(nameIdf, 1e-6);
    const queryCoverage = Math.min(1, weightedIdf / (0.3 * query.totalIdf));
    // Names matched only through common terms ("flask", idf ~0.5) are weak evidence.
    const strength = Math.min(1, rawIdf / 3);
    const nameScore = Math.min(1, (0.65 * nameCoverage + 0.35 * queryCoverage) * (0.5 + 0.5 * strength));
    return { score: Math.max(nameScore, evidence), matched };
  }

  private pathProximity(file: IndexedFile, query: QueryModel, focus: string[]): number {
    const meaningful = file.pathTerms.filter((t) => !GENERIC_PATH_TERMS.has(t));
    let hitIdf = 0;
    let totalIdf = 0;
    for (const term of meaningful) {
      const idf = this.index.pathIdf(term);
      totalIdf += idf;
      if (query.weights.has(term)) {
        hitIdf += (query.weights.get(term) ?? 0) * idf;
      }
    }
    let score = totalIdf > 0 ? 0.6 * (hitIdf / totalIdf) : 0;
    const isTest = /(^|\/)(tests?|testing)\//.test(file.path) || /(^|\/)test_[^/]+$|_test\.[a-z]+$/.test(file.path);
    const isDoc = file.language === 'rst' || file.language === 'markdown' || /(^|\/)docs?\//.test(file.path);
    if (query.wantsTests && isTest) {
      score += 0.3;
    }
    if (query.wantsDocs && isDoc) {
      score += 0.3;
    }
    if (!query.wantsTests && isTest) {
      score *= 0.7;
    }
    if (!query.wantsDocs && isDoc) {
      score *= 0.7;
    }
    let focusScore = 0;
    for (const target of focus) {
      focusScore = Math.max(focusScore, proximity(file.path, target));
    }
    return Math.min(1, score + 0.5 * focusScore);
  }

  private explain(path: string, chunks: ScoredChunk[], query: QueryModel, focus: string[], pairedWith?: string): string {
    const parts: string[] = [];
    const best = chunks.slice(0, 4);
    const isCliPath = pathTerms(path).includes('cli');
    // Decorator evidence grouped by callable: `@click.command ("run", "shell", "routes")`.
    const byCallable = new Map<string, string[]>();
    for (const item of chunks.slice(0, 8)) {
      for (const deco of item.chunk.decorators) {
        const head = decoratorHead(deco);
        const callable = head.split('(')[0]!;
        if (!terms(callable).some((t) => (query.weights.get(t) ?? 0) >= 1)) {
          continue;
        }
        const args = byCallable.get(callable) ?? [];
        const arg = /\("([^"]*)"\)$/.exec(head)?.[1];
        if (arg && !args.includes(arg)) {
          args.push(arg);
        }
        byCallable.set(callable, args);
      }
    }
    for (const [callable, args] of [...byCallable.entries()].slice(0, 2)) {
      const label = isCliPath && /command/.test(callable) ? 'CLI command registration' : 'decorator';
      parts.push(`${label} ${callable}${args.length > 0 ? ` (${args.slice(0, 4).map((a) => `"${a}"`).join(', ')})` : ''}`);
    }
    const site = chunks.slice(0, 8).find((item) => item.references.length > 0);
    if (site) {
      const call = /\.(add_\w+|register\w*)\(/.exec(site.chunk.text)?.[1];
      parts.push(`${call ? `${call}() registration` : 'usage'} of ${site.references.slice(0, 3).join(', ')} in ${site.chunk.qualifiedName}`);
    }
    const symbols = best.filter((item) => item.components.symbol >= 0.25 && item.chunk.kind !== 'module' && item.chunk.kind !== 'block').map((item) => item.chunk.qualifiedName);
    if (symbols.length > 0) {
      const label = best[0]!.chunk.kind === 'section' ? 'sections' : 'symbols';
      parts.push(`${label} ${[...new Set(symbols)].slice(0, 3).join(', ')}`);
    }
    const isTest = /(^|\/)tests?\//.test(path) || /test_/.test(path);
    const isDoc = /\.(rst|md)$/.test(path);
    if (query.wantsTests && isTest) {
      parts.push('test module (task asks for tests)');
    }
    if (query.wantsDocs && isDoc) {
      parts.push('documentation (task asks for docs)');
    }
    if (pairedWith) {
      parts.push(`pairs with ${pairedWith}`);
    }
    if (focus.some((f) => proximity(path, f) >= 0.7)) {
      parts.push('near the active/mentioned file');
    }
    if (parts.length === 0) {
      const keywords = [...new Set(chunks.flatMap((c) => c.matchedBodyTerms))].slice(0, 4);
      parts.push(`keywords ${keywords.join(', ')}`);
    }
    return `Matched ${parts.join('; ')} in ${path}`;
  }
}

/** First clause of an instruction, e.g. "Add a new built-in CLI command flask config". */
export function headClause(raw: string): string {
  const words = raw.trim().split(/\s+/);
  const out: string[] = [];
  for (const word of words) {
    if (out.length >= 2 && /^(that|which|so|where|when|because|while|and|but|to|with)$/i.test(word)) {
      break;
    }
    out.push(word);
    if (out.length >= 2 && /[,.;:!?]$/.test(word)) {
      break;
    }
    if (out.length >= 12) {
      break;
    }
  }
  return out.join(' ');
}

type FileCategory = 'source' | 'test' | 'doc';

export function categoryOf(path: string): FileCategory {
  if (/(^|\/)(tests?|testing)\//.test(path) || /(^|\/)test_[^/]+$|_test\.[a-z]+$/.test(path)) {
    return 'test';
  }
  if (/\.(rst|md|markdown)$/i.test(path) || /(^|\/)docs?\//.test(path)) {
    return 'doc';
  }
  return 'source';
}

/** 1 = same file, 0.7 = same stem in another folder (cli.py ↔ test_cli.py ↔ cli.rst), 0.4 = same folder. */
function proximity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const stemOf = (p: string) =>
    p
      .split('/')
      .pop()!
      .replace(/\.[^.]+$/, '')
      .replace(/^test_|_test$|^tests?_/, '');
  if (stemOf(a) === stemOf(b) && stemOf(a).length > 1) {
    return 0.7;
  }
  const dir = (p: string) => p.split('/').slice(0, -1).join('/');
  return dir(a) === dir(b) ? 0.4 : 0;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
