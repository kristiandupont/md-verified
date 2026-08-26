#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   bun run check.ts examples/spec.md
 *   bun run check.ts examples/*.md --write
 *   bun run check.ts examples/spec.md --json
 */
import { existsSync } from 'node:fs';
import { glob, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';

/** Where documents live when the caller does not say. */
const DEFAULT_DOCS = '**/*.md';
/** Never walk into these while globbing. */
const IGNORED_DIRS = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|out)(\/|$)/;

import { loadGlue, resolveGlue, runFile, type RunOptions } from './src/runner.ts';
import { c, formatRun, rewriteFromRun, setColor } from './src/report.ts';
import { verify } from './src/framework.ts';
import { parseMarkdown } from './src/parser.ts';
import type { RunResult } from './src/types.ts';

interface Flags extends RunOptions {
  files: string[];
  glue?: string;
  write: boolean;
  report: boolean;
  reset: boolean;
  stamp: boolean;
  covering?: string;
  json: boolean;
  verbose: boolean;
  help: boolean;
}

const USAGE = `
md-verified - executable specifications from native Markdown

USAGE
  md-verified <file.md|glob> [...] [options]

  Globs are expanded by the tool, so quoting them is safe:
  md-verified 'docs/**/*.md'

OPTIONS
  --glue <path>     Glue module to load. Defaults to a <!-- verify: --> hint in
                    the document, then <name>.verify.ts next to it.
  --write, -w       Write status glyphs and error comments back into the file.
  --report          Print the annotated Markdown to stdout instead of writing.
  --reset           Return every anchor to its unrun state and drop our comments.
  --json            Emit machine-readable results (for agents and CI).
  --stamp           Record the current digest on every review, marking the
                    prose as read. Deliberately separate from --write.
  --covering <path> Instead of checking, list the reviews that cover <path>.
                    Answers "which documents describe this code?" without
                    putting a marker in the code itself. Searches the documents
                    given, or **/*.md when none are.
  --no-links        Skip link, anchor and symbol checking.
  --no-reviews      Skip review staleness checking.
  --no-symbols      Check links, but do not import modules to check symbols.
  --only <id>       Run only this anchor. Repeatable.
  --bail            Stop at the first failure.
  --timeout <ms>    Per-case timeout. Default 5000, 0 to disable.
  --verbose, -v     Show passing cases and stack frames.
  --no-color        Disable ANSI colour.
  --help, -h        Show this message.

EXIT CODE
  0 when every anchor passed, 1 otherwise.
`.trim();

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    files: [],
    write: false,
    report: false,
    reset: false,
    stamp: false,
    json: false,
    verbose: false,
    help: false,
    only: [],
    bail: false,
    timeout: 5000,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--glue': flags.glue = argv[++i]; break;
      case '--only': flags.only!.push(argv[++i]!); break;
      case '--timeout': flags.timeout = Number(argv[++i]); break;
      case '--write': case '-w': flags.write = true; break;
      case '--report': flags.report = true; break;
      case '--reset': flags.reset = true; break;
      case '--json': flags.json = true; break;
      case '--verbose': case '-v': flags.verbose = true; break;
      case '--no-color': setColor(false); break;
      case '--stamp': flags.stamp = true; break;
      case '--covering': flags.covering = argv[++i]; break;
      case '--no-links': flags.links = false; break;
      case '--no-reviews': flags.reviews = false; break;
      case '--no-symbols': flags.symbols = false; break;
      case '--help': case '-h': flags.help = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
        flags.files.push(arg);
    }
  }
  return flags;
}
async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  // JSON goes to stdout alone, so it stays pipeable.
  if (flags.json) setColor(false);

  if (flags.covering) {
    // Answering "which docs describe this file?" should not require the caller
    // to remember where the documents live. Finding nothing is an answer here,
    // not an error.
    const searched = await expand(flags.files.length ? flags.files : [DEFAULT_DOCS]);
    return await listCovering(flags, searched.files);
  }

  if (flags.files.length === 0) {
    console.log(USAGE);
    return 1;
  }

  const { files, unmatched } = await expand(flags.files);
  const runs: RunResult[] = [];

  // A pattern that matches nothing is a failure, not a quiet no-op: in CI it
  // would otherwise turn a moved or misspelled document path into a pass.
  let failures = unmatched.length;
  for (const pattern of unmatched) {
    console.error(`md-verified: no files match ${pattern}`);
  }

  for (const file of files) {
    try {
      const run = await checkOne(file, flags);
      runs.push(run);
      if (!run.ok) failures++;
    } catch (err) {
      // One unusable document must not stop the others being reported.
      console.error(`${file}: ${(err as Error).message}`);
      failures++;
    }
  }

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          ok: failures === 0,
          files: runs.map((r) => ({
            file: r.file,
            ok: r.ok,
            summary: r.summary,
            problems: r.problems,
            reviews: r.reviews,
            anchors: r.anchors.map((a) => ({
              id: a.id,
              kind: a.kind,
              line: a.line,
              status: a.status,
              reason: a.reason,
              cases: a.cases.map((cse) => ({
                name: cse.name,
                status: cse.status,
                line: cse.line,
                error: cse.error,
              })),
            })),
          })),
        },
        null,
        2,
      ),
    );
  }

  return failures === 0 ? 0 : 1;
}

/** Check one document. Throws only when the document cannot be run at all. */
async function checkOne(file: string, flags: Flags): Promise<RunResult> {
  // Each document gets a clean registry, so ids only need to be unique per file.
  verify.reset();

  if (!existsSync(file)) throw new Error('no such file');

  const source = await readFile(file, 'utf8');
  const gluePath = resolveGlue(file, flags.glue, source);

  // Glue is only required by anchors. A document that is prose plus reviews
  // has nothing to execute, and should not be nagged for a handler file.
  if (!gluePath && !flags.reset && parseMarkdown(source, file).anchors.length > 0) {
    throw new Error(
      `no glue code found. Add a <!-- verify: ./x.verify.ts --> hint, ` +
        `create ${basename(file, extname(file))}.verify.ts next to it, or pass --glue.`,
    );
  }
  if (gluePath) await loadGlue(gluePath);

  const { run, parsed } = await runFile(file, {
    only: flags.only!.length ? flags.only : undefined,
    bail: flags.bail,
    timeout: flags.timeout,
    links: flags.links,
    symbols: flags.symbols,
    reviews: flags.reviews,
  });

  if (flags.write || flags.report || flags.reset || flags.stamp) {
    const next = rewriteFromRun(run, parsed, { reset: flags.reset, stamp: flags.stamp });

    if (flags.report) {
      if (!flags.json) console.log(next);
    } else if (next !== run.source) {
      await writeFile(file, next);
    }
  }

  // A stamped review is current from this moment on. Reporting it as stale --
  // and exiting non-zero -- would be complaining about the very thing the
  // command just resolved, and would make `--stamp && ...` impossible.
  const settled = flags.stamp ? afterStamping(run) : run;

  if (!flags.json && !flags.report) {
    console.log(formatRun(settled, { verbose: flags.verbose }));
    console.log('');
  }

  return settled;
}

/**
 * Fold a `--stamp` into the result: reviews that received a digest are now
 * current. Reviews that failed for a reason stamping cannot fix -- covering a
 * file that does not exist, declaring no targets -- are left failing.
 */
function afterStamping(run: RunResult): RunResult {
  const reviews = run.reviews.map((review) =>
    review.status === 'failed' && review.digest !== null
      ? { ...review, status: 'passed' as const, reason: null, current: true }
      : review,
  );

  const reviewsStale = reviews.filter((r) => r.status === 'failed').length;
  const summary = { ...run.summary, reviewsStale };

  return {
    ...run,
    reviews,
    summary,
    ok: summary.failed === 0 && reviewsStale === 0 && run.problems.length === 0,
  };
}

/**
 * Expand the file arguments, globbing any that need it.
 *
 * Shells do not always expand a pattern -- it may be quoted, or there may be no
 * matching file in the current directory -- and passing `docs/*.md` through
 * verbatim produced a raw `ENOENT` on the literal string.
 */
async function expand(patterns: string[]): Promise<{ files: string[]; unmatched: string[] }> {
  const found: string[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    if (!/[*?[\]{}]/.test(pattern)) {
      if (!seen.has(pattern)) {
        seen.add(pattern);
        found.push(pattern);
      }
      continue;
    }

    const matches: string[] = [];
    for await (const match of glob(pattern)) {
      const path = String(match);
      // Skip dotfiles and vendored trees explicitly, so behaviour does not
      // depend on which runtime's glob defaults are in play.
      if (IGNORED_DIRS.test(path) || /(^|\/)\./.test(path)) continue;
      matches.push(path);
    }

    if (matches.length === 0) {
      unmatched.push(pattern);
      continue;
    }
    for (const match of matches.sort()) {
      if (seen.has(match)) continue;
      seen.add(match);
      found.push(match);
    }
  }

  return { files: found, unmatched };
}

/**
 * The reverse of `Covers:`.
 *
 * The mapping from prose to code already exists in the documents, so the
 * question "which docs describe this file?" can be answered by reading them --
 * no marker in the source, nothing extra to keep in sync.
 */
async function listCovering(flags: Flags, files: string[]): Promise<number> {
  const target = resolve(flags.covering!);
  const hits: Array<{ file: string; id: string; line: number; target: string }> = [];

  for (const file of files) {
    if (!existsSync(file)) continue;
    const parsed = parseMarkdown(await readFile(file, 'utf8'), file);
    const dir = dirname(resolve(file));

    for (const review of parsed.reviews) {
      for (const cover of review.covers) {
        const [path] = cover.split('#');
        if (resolve(dir, (path ?? '').trim()) === target) {
          hits.push({ file, id: review.id, line: review.line, target: cover });
        }
      }
    }
  }

  if (flags.json) {
    console.log(JSON.stringify({ covering: flags.covering, reviews: hits }, null, 2));
  } else if (hits.length === 0) {
    console.log(
      `No review covers ${flags.covering} (searched ${files.length} document${files.length === 1 ? '' : 's'}).`,
    );
  } else {
    console.log(`Reviews covering ${flags.covering}:`);
    for (const hit of hits) {
      console.log(`  ${hit.file}:${hit.line}  ${hit.id}  ${c.dim(hit.target)}`);
    }
    console.log('');
    console.log(c.dim('Changing this file may make the prose above wrong. Re-read it, then --stamp.'));
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`md-verified: ${(err as Error).message}`);
    process.exit(1);
  },
);
