/**
 * The value-type registry backing `**Schema:**` declarations.
 *
 * A schema turns opaque cell text into real JavaScript values, so glue code
 * compares numbers to numbers instead of re-parsing `"$16.00"` by hand.
 */

/** Thrown when a cell cannot be read as its declared type. */
export class CoercionError extends Error {
  constructor(
    readonly value: string,
    readonly type: string,
    detail?: string,
  ) {
    super(`cannot read ${JSON.stringify(value)} as ${type}${detail ? ` (${detail})` : ''}`);
    this.name = 'CoercionError';
  }
}

export type Coercer = (raw: string, typeName: string) => unknown;

const registry = new Map<string, Coercer>();

/** Register a value type usable from a `**Schema:**` line. Case-insensitive. */
export function registerType(name: string, coerce: Coercer): void {
  registry.set(name.toLowerCase(), coerce);
}

export function hasType(name: string): boolean {
  return registry.has(name.toLowerCase());
}

export function knownTypes(): string[] {
  return [...registry.keys()].sort();
}

/** Coerce one cell. `optional` lets blank cells through as `null`. */
export function coerce(raw: string, type: string, optional = false): unknown {
  const text = raw.trim();
  if (optional && (text === '' || text === '-' || text === '—')) return null;

  const fn = registry.get(type.toLowerCase());
  if (!fn) {
    throw new CoercionError(text, type, `unknown type; known types: ${knownTypes().join(', ')}`);
  }
  return fn(text, type);
}

// ---------------------------------------------------------------------------
// Built-ins
// ---------------------------------------------------------------------------

/** `$1,234.50`, `(1,234.50)` and `-€12` all become numbers. */
function parseNumeric(raw: string, type: string): number {
  let text = raw.trim();
  let sign = 1;

  // Accounting-style negatives: (12.00)
  const paren = /^\((.*)\)$/.exec(text);
  if (paren) {
    sign = -1;
    text = paren[1]!.trim();
  }

  text = text.replace(/[$€£¥₹]|\b(?:USD|EUR|GBP|JPY|DKK)\b/gi, '').replace(/[,\s_]/g, '');

  if (text.startsWith('-')) {
    sign *= -1;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }

  if (text === '' || !/^\d*\.?\d+(?:e[+-]?\d+)?$/i.test(text)) {
    throw new CoercionError(raw, type);
  }
  return sign * Number(text);
}

registerType('Currency', (raw, type) => {
  const n = parseNumeric(raw, type);
  // Money is compared for equality constantly; keep it off the float knife-edge.
  return Math.round(n * 1e6) / 1e6;
});

registerType('Percentage', (raw, type) => {
  const hasSign = raw.includes('%');
  const n = parseNumeric(raw.replace('%', ''), type);
  // `10%` -> 0.1 so it multiplies directly. A bare `0.1` is already a fraction.
  return hasSign ? Math.round((n / 100) * 1e6) / 1e6 : n;
});

registerType('Number', parseNumeric);
registerType('Float', parseNumeric);
registerType('Decimal', parseNumeric);

registerType('Integer', (raw, type) => {
  const n = parseNumeric(raw, type);
  if (!Number.isInteger(n)) throw new CoercionError(raw, type, 'not a whole number');
  return n;
});
registerType('Int', (raw, type) => coerce(raw, 'Integer') as number);

const TRUE = new Set(['true', 'yes', 'y', '1', 'on', '✅', 'x', '☑', '✓']);
const FALSE = new Set(['false', 'no', 'n', '0', 'off', '❌', '', '☐', '-']);

registerType('Boolean', (raw, type) => {
  const key = raw.trim().toLowerCase();
  if (TRUE.has(key)) return true;
  if (FALSE.has(key)) return false;
  throw new CoercionError(raw, type);
});
registerType('Bool', (raw) => coerce(raw, 'Boolean') as boolean);

registerType('Date', (raw, type) => {
  const d = new Date(raw.trim());
  if (Number.isNaN(d.getTime())) throw new CoercionError(raw, type);
  return d;
});

registerType('String', (raw) => raw.trim());
registerType('Text', (raw) => raw.trim());

registerType('JSON', (raw, type) => {
  try {
    return JSON.parse(raw.trim());
  } catch (err) {
    throw new CoercionError(raw, type, (err as Error).message);
  }
});

/** `a, b, c` -> `['a', 'b', 'c']`. */
registerType('List', (raw) =>
  raw
    .trim()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
