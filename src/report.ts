/**
 * Reporting, in two directions.
 *
 * *Outward*, to a human at a terminal: coloured pass/fail lines.
 *
 * *Back into the document*, for the next reader -- human or agent: the anchor
 * glyph is rewritten to reflect the run, and failures are recorded as HTML
 * comments directly beneath the anchor. Those comments are invisible in every
 * Markdown renderer, so the document still looks hand-written, but they give
 * an agent the exact failure text at exactly the place it must fix.
 *
 * Rewriting is a surgical splice against the original source -- never a
 * re-serialisation of the AST -- so every byte the author wrote that we did
 * not deliberately change survives untouched.
 */
import { STATUS_GLYPH, type Anchor, type AnchorResult, type RunResult, type Status } from './types.ts';

/** Anchor first line: quote marker, optional glyph, then the bold body. */
const FIRST_LINE_RE = /^(?<prefix>\s*>\s*)(?<glyph>[^\s*`]+\s+)?(?<body>\*\*\s*Verified[\s\S]*)$/;
/** A status parenthetical we own and may replace. */
const SUFFIX_RE = /\s*\((?:Failed|Passed|Skipped|Pending)[^)]*\)\s*$/i;
/** A whole line holding one of our comments. */
const MANAGED_LINE_RE = /^[ \t]*<!--\s*(?:ERROR|VERIFY)\b[^\n]*?-->[ \t]*\r?\n?/gm;

/** Most failures we will write into the document before summarising. */
const MAX_COMMENTS = 8;

export interface RewriteOptions {
  /** Ignore results and return every anchor to its unrun state. */
  reset?: boolean;
}

/**
 * Return `source` with each anchor's glyph and error comments brought in line
 * with `results`.
 */
export function rewriteMarkdown(
  source: string,
  anchors: Anchor[],
  results: AnchorResult[],
  options: RewriteOptions = {},
): string {
  const byAnchor = new Map(results.map((r) => [r.line + ':' + r.id, r]));
  let out = source;

  // Back to front, so earlier offsets stay valid as we splice.
  for (const anchor of [...anchors].sort((a, b) => b.quoteRange.start - a.quoteRange.start)) {
    const result = byAnchor.get(anchor.line + ':' + anchor.id);
    const status: Status = options.reset ? 'pending' : (result?.status ?? 'pending');

    const quote = out.slice(anchor.quoteRange.start, anchor.quoteRange.end);
    const gap = out.slice(anchor.gapRange.start, anchor.gapRange.end);
    const comments = options.reset ? [] : commentsFor(result);

    out =
      out.slice(0, anchor.quoteRange.start) +
      rewriteQuote(quote, status, result, options.reset === true) +
      rewriteGap(gap, comments) +
      out.slice(anchor.gapRange.end);
  }

  return out;
}

/** Convenience: rewrite straight from a `RunResult`. */
export function rewriteFromRun(
  run: RunResult,
  anchors: Anchor[],
  options: RewriteOptions = {},
): string {
  return rewriteMarkdown(run.source, anchors, run.anchors, options);
}

function rewriteQuote(
  quote: string,
  status: Status,
  result: AnchorResult | undefined,
  reset: boolean,
): string {
  const lines = quote.split('\n');
  const m = FIRST_LINE_RE.exec(lines[0]!);
  if (!m) return quote;

  const body = m.groups!.body!.replace(SUFFIX_RE, '');
  const suffix = reset ? '' : suffixFor(status, result);

  lines[0] = m.groups!.prefix! + STATUS_GLYPH[status] + ' ' + body + (suffix ? ' ' + suffix : '');
  return lines.join('\n');
}

function suffixFor(status: Status, result: AnchorResult | undefined): string {
  if (status === 'skipped') return '(Skipped)';
  if (status !== 'failed') return '';

  const total = result?.cases.length ?? 0;
  const failed = result?.cases.filter((x) => x.status === 'failed').length ?? 0;
  // Only worth counting when the asset fanned out into several cases.
  return total > 1 ? `(Failed: ${failed} of ${total})` : '(Failed)';
}

function commentsFor(result: AnchorResult | undefined): string[] {
  if (!result) return [];
  const lines: string[] = [];

  if (result.status === 'skipped') {
    if (result.reason) lines.push(comment('VERIFY', result.reason));
    return lines;
  }
  if (result.status !== 'failed') return lines;

  if (result.reason) lines.push(comment('ERROR', result.reason));

  // Deliberately no line numbers: writing these comments shifts the very lines
  // they would cite, so citing them would make annotation non-idempotent. The
  // case name identifies the case, and the comment already sits directly above
  // the asset. Exact lines live in --json and the terminal report.
  const failures = result.cases.filter((x) => x.status === 'failed');
  for (const cse of failures.slice(0, MAX_COMMENTS)) {
    lines.push(comment('ERROR', `${cse.name}: ${cse.error ?? 'failed'}`));
  }
  if (failures.length > MAX_COMMENTS) {
    lines.push(comment('ERROR', `... and ${failures.length - MAX_COMMENTS} more failure(s)`));
  }

  return lines;
}

/** Build one single-line comment that cannot break out of its own delimiters. */
function comment(tag: string, message: string): string {
  const safe = String(message)
    .replace(/\r?\n/g, ' \u23ce ')
    .replace(/<!--/g, '&lt;!--')
    .replace(/-->/g, '->>')
    .replace(/\s+/g, ' ')
    .trim();
  return `<!-- ${tag}: ${safe} -->`;
}

function rewriteGap(gap: string, comments: string[]): string {
  // Drop whatever we wrote last time; keep anything the author added.
  const authored = gap.replace(MANAGED_LINE_RE, '').trim();

  const parts: string[] = [];
  if (authored) parts.push(authored);
  if (comments.length) parts.push(comments.join('\n'));

  // A blank line on both sides keeps the blockquote and the asset as separate
  // blocks, which is what makes the lookahead binding stable.
  return parts.length ? '\n\n' + parts.join('\n\n') + '\n\n' : '\n\n';
}

// ---------------------------------------------------------------------------
// Terminal output
// ---------------------------------------------------------------------------

const ESC = String.fromCharCode(27);

let colorEnabled =
  !process.env.NO_COLOR && Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';

/** Force colour on or off (the CLI's `--no-color` flag routes through here). */
export function setColor(on: boolean): void {
  colorEnabled = on;
}

const paint = (code: string) => (s: string) =>
  colorEnabled ? `${ESC}[${code}m${s}${ESC}[0m` : s;

export const c = {
  green: paint('32'),
  red: paint('31'),
  yellow: paint('33'),
  blue: paint('36'),
  dim: paint('2'),
  bold: paint('1'),
};

const MARK: Record<string, () => string> = {
  passed: () => c.green('\u2714'),
  failed: () => c.red('\u2716'),
  skipped: () => c.yellow('\u25cb'),
};

/** Render a run as terminal text. */
export function formatRun(run: RunResult, options: { verbose?: boolean } = {}): string {
  const out: string[] = [];
  out.push(c.bold(run.file));

  for (const p of run.problems) {
    out.push(`  ${c.red('\u2716')} ${c.dim(`line ${p.line}`)} ${p.message}`);
  }

  for (const a of run.anchors) {
    const counts =
      a.cases.length > 1
        ? c.dim(` ${a.cases.filter((x) => x.status === 'passed').length}/${a.cases.length}`)
        : '';
    const reason = a.status === 'skipped' && a.reason ? c.dim(` \u2014 ${a.reason}`) : '';

    out.push(
      `  ${MARK[a.status]!()} ${a.id}${counts} ${c.dim(`(${a.kind}, line ${a.line})`)}${reason}`,
    );

    if (a.status === 'failed' && a.reason) out.push(`      ${c.red(a.reason)}`);

    for (const cse of a.cases) {
      if (cse.status === 'failed') {
        const where = cse.line ? `:${cse.line}` : '';
        out.push(`      ${c.dim(cse.name + where)}  ${c.red(cse.error ?? 'failed')}`);
        if (options.verbose && cse.stack) {
          out.push(...cse.stack.split('\n').slice(1, 4).map((l) => c.dim('        ' + l.trim())));
        }
      } else if (options.verbose) {
        out.push(`      ${c.green('\u00b7')} ${c.dim(cse.name)}`);
      }
    }
  }

  const s = run.summary;
  const bits = [
    s.passed ? c.green(`${s.passed} passed`) : null,
    s.failed ? c.red(`${s.failed} failed`) : null,
    s.skipped ? c.yellow(`${s.skipped} skipped`) : null,
  ].filter(Boolean);

  out.push('');
  out.push(
    `  ${bits.join(c.dim(', ')) || c.dim('nothing to verify')} ${c.dim(
      `(${s.cases} case${s.cases === 1 ? '' : 's'}, ${s.durationMs.toFixed(0)}ms)`,
    )}`,
  );

  return out.join('\n');
}
