/**
 * Review staleness.
 *
 * An anchor executes a claim. Most of a good document is not executable --
 * rationale, context, the reason a rule exists at all -- and that prose is
 * usually the part worth reading. It is also the part that rots silently.
 *
 * A review does not attempt to verify prose. It records which code a section
 * describes, and a digest of that code at the moment someone last read the two
 * together. When the code changes the digest stops matching, and the section
 * is flagged for a human to re-read. That is an attestation, not a proof, and
 * it is deliberately the weaker claim -- the alternative is either checking
 * nothing, or pretending prose can be executed.
 *
 * Stamping is a separate, deliberate act (`--stamp`). It is never done by
 * `--write`, because a stamp applied automatically would attest to nothing.
 */
import { dirname, resolve as resolvePath } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { exportedSymbol } from './symbols.ts';
import type { ParseResult, Review, ReviewResult } from './types.ts';

/** How many hex characters of the digest we record. */
const DIGEST_LENGTH = 12;

/**
 * Digest format version, recorded in the stamp.
 *
 * The algorithm is part of the file format: change it and every stamp in every
 * repository stops matching. Without a version marker that would be reported
 * as "the code changed" -- a lie, and one that trains people to stamp blindly.
 * With it, we can say what actually happened.
 */
const DIGEST_VERSION = '1';

export interface ReviewOptions {
  /** Skip review checking entirely. */
  reviews?: boolean;
}

/** Check every review in a document against the code it covers. */
export function checkReviews(parsed: ParseResult, options: ReviewOptions = {}): ReviewResult[] {
  if (options.reviews === false) return [];

  const dir = dirname(resolvePath(parsed.file));
  return parsed.reviews.map((review) => check(review, dir));
}

function check(review: Review, dir: string): ReviewResult {
  const base = { id: review.id, line: review.line };

  if (review.defect) {
    return { ...base, status: 'failed', reason: review.defect, digest: null, current: false };
  }

  const computed = digestOf(review.covers, dir);
  if (computed instanceof Error) {
    return { ...base, status: 'failed', reason: computed.message, digest: null, current: false };
  }

  if (!review.digest) {
    return {
      ...base,
      status: 'failed',
      reason: `never stamped; read this section against ${review.covers.join(', ')}, then run --stamp`,
      digest: computed,
      current: false,
    };
  }

  if (!review.digest.startsWith(`${DIGEST_VERSION}:`)) {
    return {
      ...base,
      status: 'failed',
      reason: `stamped with an older digest format, so it cannot be compared; the code may well be unchanged. Re-read and run --stamp`,
      digest: computed,
      current: false,
    };
  }

  if (review.digest !== computed) {
    return {
      ...base,
      status: 'failed',
      reason: `${review.covers.join(', ')} changed since this section was last read; re-read it, correct it if it is now wrong, then run --stamp`,
      digest: computed,
      current: false,
    };
  }

  return { ...base, status: 'passed', reason: null, digest: computed, current: true };
}

/**
 * Digest the source of everything a review covers.
 *
 * A target is either a whole file (`./checkout.ts`) or one exported symbol
 * (`./checkout.ts#calculateTotal`). Prefer the symbol form: a file-level
 * digest is invalidated by every unrelated edit in that file, and a review
 * that cries wolf gets stamped without being read.
 *
 * Leading comments are excluded from a symbol's text, so rewording a doc
 * comment does not demand a re-review.
 */
export function digestOf(covers: string[], dir: string): string | Error {
  if (covers.length === 0) {
    return new Error('declares no **Covers:** targets, so there is nothing to go stale against');
  }

  const hasher = createHash('sha256');

  for (const target of covers) {
    const text = sourceOf(target, dir);
    if (text instanceof Error) return text;
    hasher.update(`${target} ${text} `);
  }

  return `${DIGEST_VERSION}:${hasher.digest('hex').slice(0, DIGEST_LENGTH)}`;
}

/** The source text a single `Covers:` target refers to. */
function sourceOf(target: string, dir: string): string | Error {
  const hash = target.indexOf('#');
  const filePart = (hash === -1 ? target : target.slice(0, hash)).trim();
  const symbol = hash === -1 ? null : target.slice(hash + 1).trim();

  const path = resolvePath(dir, filePart);
  if (!existsSync(path)) {
    return new Error(`covers ${target}, but ${filePart} does not exist`);
  }

  if (!symbol) {
    try {
      return normalise(readFileSync(path, 'utf8'));
    } catch (err) {
      return new Error(`covers ${target}, but it could not be read: ${(err as Error).message}`);
    }
  }

  const found = exportedSymbol(path, symbol);
  if (found instanceof Error) {
    return new Error(`covers ${target}, but ${filePart} could not be read: ${found.message}`);
  }
  if (!found) {
    return new Error(`covers ${target}, but ${filePart} exports no \`${symbol}\``);
  }
  return normalise(found.text);
}

/**
 * Line endings are a property of the checkout, not of the code.
 *
 * Without this, a team with mixed Windows and Unix working copies -- or one
 * `core.autocrlf` setting -- sees every review go stale on every machine, and
 * learns to stamp without reading.
 */
function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
