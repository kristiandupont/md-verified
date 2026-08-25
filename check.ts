#!/usr/bin/env bun
/**
 * CLI entry point.
 *
 *   bun run check.ts examples/spec.md
 *   bun run check.ts examples/*.md --write
 *   bun run check.ts examples/spec.md --json
 */
import { basename } from 'node:path';

import { loadGlue, resolveGlue, runFile, type RunOptions } from './src/runner.ts';
import { formatRun, rewriteMarkdown, setColor } from './src/report.ts';
import { verify } from './src/framework.ts';
import type { RunResult } from './src/types.ts';

interface Flags extends RunOptions {
  files: string[];
  glue?: string;
  write: boolean;
  report: boolean;
  reset: boolean;
  json: boolean;
  verbose: boolean;
  help: boolean;
}

const USAGE = `
md-verified - executable specifications from native Markdown

USAGE
  bun run check.ts <file.md> [...] [options]

OPTIONS
  --glue <path>     Glue module to load. Defaults to a <!-- verify: --> hint in
                    the document, then <name>.verify.ts next to it.
  --write, -w       Write status glyphs and error comments back into the file.
  --report          Print the annotated Markdown to stdout instead of writing.
  --reset           Return every anchor to its unrun state and drop our comments.
  --json            Emit machine-readable results (for agents and CI).
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

  if (flags.help || flags.files.length === 0) {
    console.log(USAGE);
    return flags.help ? 0 : 1;
  }
  // JSON goes to stdout alone, so it stays pipeable.
  if (flags.json) setColor(false);

  const runs: RunResult[] = [];
  let failures = 0;

  for (const file of flags.files) {
    // Each document gets a clean registry, so ids only need to be unique per file.
    verify.reset();

    const source = await Bun.file(file).text();
    const gluePath = resolveGlue(file, flags.glue, source);

    if (!gluePath && !flags.reset) {
      console.error(
        `${basename(file)}: no glue code found. Add a <!-- verify: ./x.verify.ts --> hint, ` +
        `create ${basename(file, '.md')}.verify.ts next to it, or pass --glue.`,
      );
      failures++;
      continue;
    }
    if (gluePath) await loadGlue(gluePath);

    const { run, parsed } = await runFile(file, {
      only: flags.only!.length ? flags.only : undefined,
      bail: flags.bail,
      timeout: flags.timeout,
    });
    runs.push(run);
    if (!run.ok) failures++;

    if (flags.write || flags.report || flags.reset) {
      const next = rewriteMarkdown(run.source, parsed.anchors, run.anchors, { reset: flags.reset });

      if (flags.report) {
        if (!flags.json) console.log(next);
      } else if (next !== run.source) {
        await Bun.write(file, next);
      }
    }

    if (!flags.json && !flags.report) {
      console.log(formatRun(run, { verbose: flags.verbose }));
      console.log('');
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

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`md-verified: ${(err as Error).message}`);
    process.exit(1);
  },
);
