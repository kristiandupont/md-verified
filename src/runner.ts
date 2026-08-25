/**
 * The execution engine.
 *
 * Loads glue code, parses a Markdown file, matches anchors to registered
 * handlers, and runs them. Everything here is pure library -- the CLI in
 * `check.ts` is a thin wrapper so the same engine can be driven from
 * `bun test` (see `spec.test.ts`).
 */
import { resolve, dirname, basename, extname, join } from 'node:path';
import { existsSync } from 'node:fs';

import { findGlueHint, parseMarkdown } from './parser.ts';
import { getRegistration, type VerifyContext } from './framework.ts';
import type {
  Anchor,
  AnchorResult,
  CaseResult,
  MermaidGraph,
  ParsedList,
  ParsedTable,
  ParseResult,
  RunResult,
} from './types.ts';

export interface RunOptions {
  /** Only run anchors whose id is in this list. */
  only?: string[];
  /** Stop after the first failing case. */
  bail?: boolean;
  /** Per-case timeout in ms. `0` disables. */
  timeout?: number;
}

/** Parse and run one Markdown file against whatever is currently registered. */
export async function runFile(file: string, options: RunOptions = {}): Promise<{
  run: RunResult;
  parsed: ParseResult;
}> {
  const path = resolve(file);
  const source = await Bun.file(path).text();
  const parsed = parseMarkdown(source, file);
  const run = await runParsed(parsed, options);
  return { run, parsed };
}

/** Run an already-parsed document. */
export async function runParsed(parsed: ParseResult, options: RunOptions = {}): Promise<RunResult> {
  const started = performance.now();
  const results: AnchorResult[] = [];

  let bailed = false;

  for (const anchor of parsed.anchors) {
    if (options.only?.length && !options.only.includes(anchor.id)) {
      results.push(skipped(anchor, 'filtered out by --only'));
      continue;
    }
    if (bailed) {
      results.push(skipped(anchor, 'not run (--bail)'));
      continue;
    }

    const result = await runAnchor(anchor, parsed.file, options);
    results.push(result);

    if (options.bail && result.status === 'failed') bailed = true;
  }

  const summary = {
    anchors: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    cases: results.reduce((n, r) => n + r.cases.length, 0),
    casesPassed: results.reduce((n, r) => n + r.cases.filter((x) => x.status === 'passed').length, 0),
    casesFailed: results.reduce((n, r) => n + r.cases.filter((x) => x.status === 'failed').length, 0),
    durationMs: performance.now() - started,
  };

  return {
    file: parsed.file,
    source: parsed.source,
    anchors: results,
    problems: parsed.problems,
    // Structural problems are failures too -- a spec that cannot bind is not green.
    ok: summary.failed === 0 && parsed.problems.length === 0,
    summary,
  };
}

/** Run every case for one anchor. */
export async function runAnchor(
  anchor: Anchor,
  file: string,
  options: RunOptions = {},
): Promise<AnchorResult> {
  const registration = getRegistration(anchor.id);

  if (!registration) {
    return skipped(anchor, `no handler registered for \`${anchor.id}\``);
  }
  if (registration.kind !== anchor.kind) {
    return {
      ...base(anchor),
      status: 'failed',
      reason: `handler for \`${anchor.id}\` is registered as verify.${registration.kind}, but the document binds it to a ${anchor.kind}`,
      cases: [],
    };
  }

  const ctx: VerifyContext = {
    id: anchor.id,
    kind: anchor.kind,
    label: anchor.label,
    file,
    line: anchor.line,
    meta: anchor.meta,
  };

  const cases = buildCases(anchor, registration.mode);
  const results: CaseResult[] = [];

  for (const c of cases) {
    if (options.bail && results.some((r) => r.status === 'failed')) {
      results.push({ name: c.name, status: 'skipped', error: null, stack: null, durationMs: 0, line: c.line });
      continue;
    }
    results.push(await runCase(c, registration.fn, ctx, options.timeout ?? 5000));
  }


  const failed = results.some((r) => r.status === 'failed');
  return {
    ...base(anchor),
    status: failed ? 'failed' : 'passed',
    reason: null,
    cases: results,
  };
}

// ---------------------------------------------------------------------------
// planning (used by `bun test` to emit one native test per case)
// ---------------------------------------------------------------------------

/** One case, ready to run. Throwing from `run` is the failure signal. */
export interface PlannedCase {
  name: string;
  line: number | null;
  run: () => Promise<void>;
}

export interface Plan {
  /** Set when the anchor cannot run at all. */
  skipReason: string | null;
  cases: PlannedCase[];
}

/**
 * Resolve an anchor into runnable cases without executing them, so a test
 * framework can own the scheduling and reporting.
 */
export function planCases(anchor: Anchor, file: string): Plan {
  const registration = getRegistration(anchor.id);

  if (!registration) {
    return { skipReason: `no handler registered for \`${anchor.id}\``, cases: [] };
  }
  if (registration.kind !== anchor.kind) {
    return {
      skipReason: `handler for \`${anchor.id}\` is verify.${registration.kind}, but the document binds a ${anchor.kind}`,
      cases: [],
    };
  }

  const ctx: VerifyContext = {
    id: anchor.id,
    kind: anchor.kind,
    label: anchor.label,
    file,
    line: anchor.line,
    meta: anchor.meta,
  };

  return {
    skipReason: null,
    cases: buildCases(anchor, registration.mode).map((c) => ({
      name: c.name,
      line: c.line,
      run: async () => {
        await registration.fn(c.payload, ctx);
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// case construction
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  line: number | null;
  payload: unknown;
}

/** Fan an asset out into the cases a handler expects. */
function buildCases(anchor: Anchor, mode: 'each' | 'all'): Case[] {
  if (mode === 'all') {
    return [{ name: anchor.kind, line: anchor.line, payload: anchor.data }];
  }

  if (anchor.kind === 'table') {
    const table = anchor.data as ParsedTable;
    return table.rows.map((row) => ({
      name: `row ${row.$index + 1}`,
      line: row.$line,
      payload: row,
    }));
  }

  if (anchor.kind === 'mermaid') {
    const graph = anchor.data as MermaidGraph;
    return graph.edges.map((edge) => ({
      name: `${edge.from} ${edge.directed ? '->' : '--'} ${edge.to}`,
      line: null,
      payload: edge,
    }));
  }

  const list = anchor.data as ParsedList;
  return list.flat.map((item) => ({
    name: truncate(item.text || `item ${item.index + 1}`, 48),
    line: item.line,
    payload: item,
  }));
}

async function runCase(
  c: Case,
  fn: (payload: unknown, ctx: VerifyContext) => unknown,
  ctx: VerifyContext,
  timeout: number,
): Promise<CaseResult> {
  const started = performance.now();
  try {
    const value = fn(c.payload, ctx);
    if (value instanceof Promise) {
      await (timeout > 0 ? withTimeout(value, timeout, c.name) : value);
    }
    return { name: c.name, status: 'passed', error: null, stack: null, durationMs: performance.now() - started, line: c.line };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      name: c.name,
      status: 'failed',
      error: error.message || String(err),
      stack: error.stack ?? null,
      durationMs: performance.now() - started,
      line: c.line,
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timed out after ${ms}ms (${label})`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); res(v); },
      (e) => { clearTimeout(timer); rej(e); },
    );
  });
}

// ---------------------------------------------------------------------------
// glue-code loading
// ---------------------------------------------------------------------------

/** Conventional glue filenames tried next to `spec.md`, in order. */
const GLUE_SUFFIXES = ['.verify.ts', '.verify.js', '.spec.ts', '.test.ts'];

/**
 * Find the glue file for a Markdown document: an explicit path wins, then a
 * `<!-- verify: ./x.ts -->` hint in the document, then convention.
 */
export function resolveGlue(mdPath: string, explicit?: string, source?: string): string | null {
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new Error(`glue file not found: ${explicit}`);
    return path;
  }

  const dir = dirname(resolve(mdPath));

  if (source) {
    const hint = findGlueHint(source);
    if (hint) {
      const path = resolve(dir, hint);
      if (!existsSync(path)) {
        throw new Error(`glue file not found: ${hint} (from a <!-- verify: --> hint in ${basename(mdPath)})`);
      }
      return path;
    }
  }

  const stem = basename(mdPath, extname(mdPath));
  for (const suffix of GLUE_SUFFIXES) {
    const candidate = join(dir, stem + suffix);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Import a glue module, bypassing the module cache so repeat runs re-register. */
export async function loadGlue(path: string): Promise<void> {
  await import(`${path}?v=${Date.now()}`);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function base(anchor: Anchor) {
  return { id: anchor.id, kind: anchor.kind, label: anchor.label, line: anchor.line };
}

function skipped(anchor: Anchor, reason: string): AnchorResult {
  return { ...base(anchor), status: 'skipped', reason, cases: [] };
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}
