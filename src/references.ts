/**
 * Referential integrity for the prose around the anchors.
 *
 * Anchors verify the *assets* in a document. This pass verifies its
 * *references*: links to files that have been moved, in-document anchors that
 * no longer resolve, and -- where the author asks for it with a fragment --
 * symbols that no longer exist.
 *
 * It deliberately checks nothing implicit. A document opts in by linking; bare
 * inline code is never treated as a symbol, because `$10.00`, `--write` and
 * `[itemsTotal: Currency]` are all inline code in a perfectly healthy spec.
 */
import { dirname, extname, resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { Nodes, Root } from 'mdast';
import { clearSymbolCache, exportedNames } from './symbols.ts';
import type { ParseProblem, ParseResult } from './types.ts';

/** File extensions we are willing to import to enumerate exports. */
const MODULE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
/** Extensions we can read headings out of. */
const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx']);

/** A link, image, or link definition found in the prose. */
export interface Reference {
  kind: 'link' | 'image' | 'definition';
  /** The URL exactly as written, or the identifier for a shorthand reference. */
  url: string;
  /** Path portion, decoded. `null` for in-document and shorthand references. */
  target: string | null;
  /** Fragment after `#`, decoded. */
  fragment: string | null;
  line: number;
  column: number;
}

export interface ReferenceOptions {
  /**
   * Check that fragment-linked symbols exist. On by default. Modules are read,
   * never imported, so nothing in the checked project is executed.
   */
  symbols?: boolean;
}

/** Collect every reference in a document, in source order. */
export function collectReferences(tree: Root): Reference[] {
  const found: Reference[] = [];

  // `linkReference` nodes are not collected: their target is the `definition`
  // they resolve to, which is checked directly. A reference with no definition
  // never becomes a node at all -- CommonMark leaves it as literal text -- so
  // there is nothing in the tree to flag.
  walk(tree, (node) => {
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
      found.push({ ...split(node.url), kind: node.type, ...at(node) });
    }
  });

  return found;
}

/**
 * Check every reference in a parsed document. Returns diagnostics in the same
 * shape as parse problems, so they flow through the runner unchanged.
 */
export async function checkReferences(
  parsed: ParseResult,
  options: ReferenceOptions = {},
): Promise<ParseProblem[]> {
  const docPath = resolvePath(parsed.file);

  // An in-memory document has no directory to resolve relative links against.
  if (!existsSync(docPath)) return [];

  const dir = dirname(docPath);
  const problems: ParseProblem[] = [];
  const headings = headingSlugs(parsed.tree);

  const report = (ref: Reference, message: string) =>
    problems.push({ id: null, line: ref.line, column: ref.column, message });

  for (const ref of collectReferences(parsed.tree)) {
    if (isExternal(ref.url)) continue;

    // A bare `#fragment` points inside this document.
    if (ref.target === null || ref.target === '') {
      if (ref.fragment && !headings.has(ref.fragment)) {
        report(ref, `broken anchor: #${ref.fragment}${suggest(ref.fragment, [...headings])}`);
      }
      continue;
    }

    const targetPath = resolvePath(dir, ref.target);
    if (!existsSync(targetPath)) {
      report(ref, `broken link: ${ref.url} (no such file)`);
      continue;
    }
    if (!ref.fragment) continue;

    const ext = extname(targetPath).toLowerCase();

    if (MARKDOWN_EXTS.has(ext)) {
      const slugs = await markdownSlugs(targetPath);
      if (slugs && !slugs.has(ref.fragment)) {
        report(ref, `broken anchor: ${ref.url} (no such heading)${suggest(ref.fragment, [...slugs])}`);
      }
      continue;
    }

    if (MODULE_EXTS.has(ext) && options.symbols !== false) {
      const exports = exportedNames(targetPath);
      if (exports instanceof Error) {
        report(ref, `could not read ${ref.target}: ${exports.message}`);
      } else if (!exports.has(ref.fragment)) {
        report(
          ref,
          `broken symbol: ${ref.url} (no export named \`${ref.fragment}\`)${suggest(ref.fragment, [...exports])}`,
        );
      }
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

const slugCache = new Map<string, Set<string> | null>();

async function markdownSlugs(path: string): Promise<Set<string> | null> {
  const cached = slugCache.get(path);
  if (cached !== undefined) return cached;

  let slugs: Set<string> | null = null;
  try {
    // Imported lazily: only documents that are actually anchor-linked are read.
    const { parseMarkdown } = await import('./parser.ts');
    slugs = headingSlugs(parseMarkdown(await readFile(path, 'utf8'), path).tree);
  } catch {
    slugs = null;
  }
  slugCache.set(path, slugs);
  return slugs;
}

/** Forget cached lookups. Tests that write fixtures on the fly need this. */
export function clearReferenceCache(): void {
  slugCache.clear();
  clearSymbolCache();
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function walk(node: Nodes, visit: (node: Nodes) => void): void {
  visit(node);
  for (const child of (node as any).children ?? []) walk(child, visit);
}

function at(node: Nodes): { line: number; column: number } {
  return { line: node.position?.start.line ?? 0, column: node.position?.start.column ?? 0 };
}

function isExternal(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');
}

function split(url: string): { url: string; target: string | null; fragment: string | null } {
  const hash = url.indexOf('#');
  if (hash === -1) return { url, target: decode(url), fragment: null };
  return {
    url,
    target: hash === 0 ? null : decode(url.slice(0, hash)),
    fragment: decode(url.slice(hash + 1)),
  };
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** GitHub-compatible heading slugs, including its `-1` disambiguation. */
export function headingSlugs(tree: Root): Set<string> {
  const slugs = new Set<string>();
  const seen = new Map<string, number>();

  walk(tree, (node) => {
    if (node.type !== 'heading') return;

    const base = slugify(textOf(node));
    if (!base) return;

    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  });

  return slugs;
}

export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function textOf(node: Nodes): string {
  let out = '';
  walk(node, (n) => {
    if (n.type === 'text' || n.type === 'inlineCode') out += (n as any).value;
  });
  return out;
}

/** " (did you mean `x`?)" when something close enough exists. */
function suggest(needle: string, haystack: string[]): string {
  let best: string | null = null;
  let bestScore = Infinity;

  for (const candidate of haystack) {
    const score = distance(needle.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  // Close enough to be a typo rather than a different thing entirely.
  const limit = Math.max(2, Math.floor(needle.length / 3));
  return best && bestScore <= limit ? ` (did you mean \`${best}\`?)` : '';
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}
