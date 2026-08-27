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
import {
  REVIEW_PENDING_GLYPH,
  STATUS_GLYPH,
  type Anchor,
  type AnchorResult,
  type Review,
  type ReviewResult,
  type RunResult,
  type Status,
} from './types.ts';

/** Anchor first line: quote marker, optional glyph, then the bold body. */
const FIRST_LINE_RE = /^(?<prefix>\s*>\s*)(?<glyph>[^\s*`]+\s+)?(?<body>\*\*\s*Verified[\s\S]*)$/;
/** The same, for a review. */
const REVIEW_LINE_RE = /^(?<prefix>\s*>\s*)(?<glyph>[^\s*`]+\s+)?(?<body>\*\*\s*Reviewed[\s\S]*)$/;
/** A `> **Digest:** ...` line inside a review blockquote. */
const DIGEST_LINE_RE = /^(?<prefix>\s*>\s*)\*\*\s*Digest\s*:?\s*\*\*\s*:?\s*.*$/;
/** A status parenthetical we own and may replace. */
const SUFFIX_RE = /\s*\((?:Failed|Passed|Skipped|Pending|Stale)[^)]*\)\s*$/i;
/**
 * A whole line holding a comment *we* wrote, and may therefore replace.
 *
 * Deliberately narrower than the parser's skip list: an author's
 * `<!-- verify: ./glue.ts -->` hint must survive a rewrite untouched, so only
 * our own `ERROR:` and `REVIEW:` comments match here.
 */
const MANAGED_LINE_RE = /^[ \t]*<!--\s*(?:ERROR|REVIEW):[\s\S]*?-->[ \t]*\r?\n?/gm;

/** Most failures we will write into the document before summarising. */
const MAX_COMMENTS = 8;

export interface RewriteOptions {
  /** Ignore results and return every anchor to its unrun state. */
  reset?: boolean;
  /**
   * Record the current digest on reviews, marking them as read.
   *
   * `true` stamps every review in the document; an array of ids stamps only
   * those. The narrow form matters: a stamp asserts that a person or agent has
   * read *that section* against the code it covers, so stamping six reviews
   * because one was re-read attests to five nobody opened.
   *
   * Deliberately separate from a normal write: applying a stamp as a side
   * effect of `--write` would make the attestation worthless.
   */
  stamp?: boolean | string[];
}

/** Whether this run stamps the review with `id`. */
export function stamps(stamp: RewriteOptions['stamp'], id: string): boolean {
  if (stamp === true) return true;
  return Array.isArray(stamp) && stamp.includes(id);
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
  reviews: Review[] = [],
  reviewResults: ReviewResult[] = [],
): string {
  const byAnchor = new Map(results.map((r) => [r.line + ':' + r.id, r]));
  const byReview = new Map(reviewResults.map((r) => [r.line + ':' + r.id, r]));

  /**
   * Anchors and reviews are interleaved in the document, so they cannot be
   * rewritten in two passes: the first pass would shift every offset the
   * second one still needs. Build one list of edits and apply it back to
   * front, which keeps every not-yet-applied offset valid.
   */
  interface Edit {
    start: number;
    end: number;
    replace: () => string;
  }

  const edits: Edit[] = [];

  for (const anchor of anchors) {
    const result = byAnchor.get(anchor.line + ':' + anchor.id);
    const status: Status = options.reset ? 'pending' : (result?.status ?? 'pending');

    edits.push({
      start: anchor.quoteRange.start,
      end: anchor.gapRange.end,
      replace: () =>
        rewriteQuote(
          source.slice(anchor.quoteRange.start, anchor.quoteRange.end),
          status,
          result,
          options.reset === true,
        ) +
        rewriteGap(
          source.slice(anchor.gapRange.start, anchor.gapRange.end),
          options.reset ? [] : commentsFor(result),
        ),
    });
  }

  for (const review of reviews) {
    const result = byReview.get(review.line + ':' + review.id);
    const status: Status = options.reset ? 'pending' : (result?.status ?? 'pending');

    // Stamping resolves the very thing the comment would report, so it clears
    // the note rather than writing one.
    const stamped = stamps(options.stamp, review.id) && Boolean(result?.digest);
    const comments =
      options.reset || stamped || status !== 'failed' || !result?.reason
        ? []
        : [comment('REVIEW', result.reason)];

    edits.push({
      start: review.quoteRange.start,
      end: review.gapRange.end,
      replace: () =>
        rewriteReviewQuote(
          source.slice(review.quoteRange.start, review.quoteRange.end),
          status,
          result,
          options,
          stamped,
        ) + rewriteGap(source.slice(review.gapRange.start, review.gapRange.end), comments),
    });
  }

  let out = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.replace() + out.slice(edit.end);
  }

  return out;
}

/** Convenience: rewrite straight from a `RunResult`. */
export function rewriteFromRun(
  run: RunResult,
  parsed: { anchors: Anchor[]; reviews: Review[] },
  options: RewriteOptions = {},
): string {
  return rewriteMarkdown(
    run.source,
    parsed.anchors,
    run.anchors,
    options,
    parsed.reviews,
    run.reviews,
  );
}

/**
 * Rewrite a review's blockquote: its glyph, and -- only when stamping -- the
 * digest recorded on it.
 */
function rewriteReviewQuote(
  quote: string,
  status: Status,
  result: ReviewResult | undefined,
  options: RewriteOptions,
  stamping: boolean,
): string {
  const lines = quote.split('\n');
  const head = REVIEW_LINE_RE.exec(lines[0] ?? '');
  if (!head) return quote;

  const glyph = options.reset
    ? REVIEW_PENDING_GLYPH
    : stamping
      ? STATUS_GLYPH.passed
      : status === 'pending'
        ? REVIEW_PENDING_GLYPH
        : STATUS_GLYPH[status];

  const body = head.groups!.body!.replace(SUFFIX_RE, '');
  const suffix = options.reset || stamping || status !== 'failed' ? '' : '(Stale)';

  lines[0] = head.groups!.prefix! + glyph + ' ' + body + (suffix ? ' ' + suffix : '');

  const prefix = head.groups!.prefix!.replace(/\s+$/, ' ');

  if (options.reset) {
    return lines.filter((l) => !DIGEST_LINE_RE.test(l)).join('\n');
  }
  if (!stamping) return lines.join('\n');

  const digestLine = `${prefix}**Digest:** \`${result!.digest}\``;
  const existing = lines.findIndex((l) => DIGEST_LINE_RE.test(l));

  if (existing === -1) lines.push(digestLine);
  else lines[existing] = digestLine;

  return lines.join('\n');
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

/** How many lines of a multi-line message we will write into a document. */
const MAX_COMMENT_LINES = 6;

/**
 * Build one comment that cannot break out of its own delimiters.
 *
 * Single-line messages -- which is what the built-in assertions produce -- stay
 * on one line. A message that genuinely has structure, typically from a
 * third-party assertion library, keeps it: flattening a diff onto one line
 * makes it unreadable in exactly the place people read it.
 */
function comment(tag: string, message: string): string {
  const safe = (text: string) =>
    text.replace(/<!--/g, '&lt;!--').replace(/-->/g, '->>').replace(/[ \t]+/g, ' ').trim();

  const lines = String(message)
    .split(/\r?\n/)
    .map(safe)
    .filter(Boolean);

  if (lines.length <= 1) return `<!-- ${tag}: ${lines[0] ?? 'failed'} -->`;

  const kept = lines.slice(0, MAX_COMMENT_LINES);
  if (lines.length > MAX_COMMENT_LINES) {
    kept.push(`... ${lines.length - MAX_COMMENT_LINES} more line(s)`);
  }
  // A blank line would end the HTML block, so there are none: `filter(Boolean)`
  // above drops them and every continuation line carries indentation.
  return `<!-- ${tag}: ${kept[0]}\n${kept.slice(1).map((l) => `     ${l}`).join('\n')} -->`;
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
    const where = p.column ? `${p.line}:${p.column}` : `line ${p.line}`;
    out.push(`  ${c.red('\u2716')} ${c.dim(where)} ${p.message}`);
  }

  for (const a of run.anchors) {
    const counts =
      a.cases.length > 1
        ? c.dim(` ${a.cases.filter((x) => x.status === 'passed').length}/${a.cases.length}`)
        : '';
    const reason = a.status === 'skipped' && a.reason ? c.dim(` \u2014 ${a.reason}`) : '';

    // A green anchor whose handler asserted nothing is the one case where a
    // checkmark actively misleads the reader, so it is called out on the
    // anchor's own line rather than left to a summary.
    const silent = a.cases.filter((x) => x.status === 'passed' && x.assertions === 0).length;
    const note =
      a.status === 'passed' && silent > 0
        ? c.yellow(` \u2014 ${silent} of ${a.cases.length} case${a.cases.length === 1 ? '' : 's'} made no assertion`)
        : '';

    out.push(
      `  ${MARK[a.status]!()} ${a.id}${counts} ${c.dim(`(${a.kind}, line ${a.line})`)}${reason}${note}`,
    );

    if (a.status === 'failed' && a.reason) {
      for (const line of a.reason.split(/\r?\n/)) {
        if (line.trim()) out.push(`      ${c.red(line.trim())}`);
      }
    }

    for (const cse of a.cases) {
      if (cse.status === 'failed') {
        const where = cse.line ? `:${cse.line}` : '';
        const [first, ...rest] = (cse.error ?? 'failed').split(/\r?\n/);
        out.push(`      ${c.dim(cse.name + where)}  ${c.red(first ?? 'failed')}`);
        for (const line of rest) {
          if (line.trim()) out.push(`        ${c.red(line.trim())}`);
        }
        if (options.verbose && cse.stack) {
          out.push(...cse.stack.split('\n').slice(1, 4).map((l) => c.dim('        ' + l.trim())));
        }
      } else if (options.verbose) {
        out.push(`      ${c.green('\u00b7')} ${c.dim(cse.name)}`);
      }
    }
  }

  for (const review of run.reviews) {
    const mark = review.status === 'passed' ? MARK.passed!() : MARK.failed!();
    out.push(`  ${mark} ${review.id} ${c.dim(`(review, line ${review.line})`)}`);
    if (review.reason) {
      for (const line of review.reason.split(/\r?\n/)) {
        if (line.trim()) out.push(`      ${c.red(line.trim())}`);
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
      `(${s.cases} case${s.cases === 1 ? '' : 's'}` +
        (s.reviews ? `, ${s.reviews - s.reviewsStale}/${s.reviews} reviews current` : '') +
        `, ${s.durationMs.toFixed(0)}ms)`,
    )}`,
  );

  return out.join('\n');
}
