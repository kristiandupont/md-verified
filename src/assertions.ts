/**
 * Assertions, written for a document rather than a terminal.
 *
 * Any assertion library works here -- a handler fails by throwing, and that is
 * the whole contract. But there is a constraint no test framework has: the
 * failure message is written *into the Markdown file* and read as
 * documentation. A terminal-shaped message is wrong for that medium:
 *
 *     <!-- ERROR: row 1: expect(received).toBe(expected) [nl] Expected: 15 [nl] Received: 16 -->
 *     <!-- ERROR: row 1: total should be $15.00, got $16.00 -->
 *
 * So these stay deliberately few, and each one produces a single self-contained
 * line phrased in terms of the claim the document is making. Reach for `assert`
 * whenever you can say it better yourself -- which is often, and is the point.
 */

/** Throw with `message` unless `condition` holds. */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Assert that a computed value matches the documented one.
 *
 * ```ts
 * equals(calculateTotal(row.items, row.tax), row.total, 'total');
 * // -> "total: expected 16, got 15"
 * ```
 *
 * Objects and arrays are compared structurally. `what` names the thing being
 * checked; without it the message is just "expected 16, got 15".
 */
export function equals(actual: unknown, expected: unknown, what?: string): void {
  if (same(actual, expected)) return;

  const subject = what ? `${what}: ` : '';
  throw new Error(`${subject}expected ${format(expected)}, got ${format(actual)}`);
}

/**
 * Assert that a value is one of a documented set.
 *
 * ```ts
 * oneOf(row.status, ['active', 'paused'], 'status');
 * // -> "status: \"archived\" is not one of active, paused"
 * ```
 */
export function oneOf(value: unknown, allowed: Iterable<unknown>, what?: string): void {
  const options = [...allowed];
  if (options.some((option) => same(value, option))) return;

  const subject = what ? `${what}: ` : '';
  throw new Error(
    `${subject}${format(value)} is not one of ${options.map((o) => String(o)).join(', ')}`,
  );
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return Bun.deepEquals(a, b, true);
  }
  return false;
}

/** How many characters of a formatted value we are willing to put in a line. */
const MAX_VALUE = 60;

/** Render a value compactly enough to sit inside a one-line comment. */
export function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined || typeof value !== 'object') return String(value);

  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}
