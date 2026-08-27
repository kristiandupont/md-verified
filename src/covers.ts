/**
 * Set assertions: does the document describe *all* of the thing?
 *
 * Per-element handlers only ever check elements that exist. If the code grows
 * a fifth payment method and nobody adds a row, every row still passes and the
 * specification is quietly wrong. `covers()` is the assertion that catches
 * that -- and because a *missing* element is machine-identifiable, it is the
 * failure an agent can act on directly.
 */
import { countAssertion } from './assertions.ts';


export interface CoversOptions {
  /**
   * Message for something present in `actual` but absent from the document.
   * Pass `false` to allow the document to describe a subset.
   */
  missing?: ((key: string) => string) | false;
  /**
   * Message for something documented that does not exist.
   * Pass `false` to allow the document to describe extras.
   */
  extra?: ((key: string) => string) | false;
  /** Flag keys the document lists more than once. Default `true`. */
  duplicates?: boolean;
  /** Noun used in the default messages. Default `"entry"`. */
  noun?: string;
}

/**
 * Assert that the keys a document lists are exactly the keys that exist.
 *
 * ```ts
 * covers(graph.edges.map((e) => `${e.from}>${e.to}`), allowedTransitions(), {
 *   missing: (k) => `${k} is allowed in code but absent from the diagram`,
 * });
 * ```
 *
 * Throws once, listing everything wrong, so a single run tells you the whole
 * gap rather than one element of it.
 */
export function covers(
  documented: Iterable<unknown>,
  actual: Iterable<unknown>,
  options: CoversOptions = {},
): void {
  countAssertion();

  const noun = options.noun ?? 'entry';
  const doc = [...documented].map(String);
  const act = [...actual].map(String);

  const docSet = new Set(doc);
  const actSet = new Set(act);

  const problems: string[] = [];

  if (options.missing !== false) {
    const say = options.missing ?? ((k: string) => `missing ${noun}: ${k}`);
    for (const key of act) {
      if (!docSet.has(key)) problems.push(say(key));
    }
  }

  if (options.extra !== false) {
    const say = options.extra ?? ((k: string) => `unexpected ${noun}: ${k}`);
    for (const key of docSet) {
      if (!actSet.has(key)) problems.push(say(key));
    }
  }

  if (options.duplicates !== false) {
    const counts = new Map<string, number>();
    for (const key of doc) counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const [key, n] of counts) {
      if (n > 1) problems.push(`duplicate ${noun}: ${key} (listed ${n} times)`);
    }
  }

  if (problems.length) {
    throw new Error(dedupe(problems).join('; '));
  }
}

/** Preserve order, drop repeats -- `actual` may itself contain duplicates. */
function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
