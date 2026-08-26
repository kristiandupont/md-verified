/**
 * Glue for `anchor-reference.md`.
 *
 * Each table here describes a closed set that exists in exactly one place in
 * the source. The handlers check two things: that everything documented is
 * real, and — via `covers` — that everything real is documented. The second
 * half is the one that catches a contributor adding a label or a type and
 * forgetting the page exists.
 */
import { assert, covers, verify } from '../src/index.ts';
import { coerce, hasType, knownTypes } from '../src/coerce.ts';
import { LABEL_KINDS } from '../src/parser.ts';
import { STATUS_GLYPH, type Status } from '../src/types.ts';

/** Strip the backticks a Markdown table cell uses for inline code. */
const bare = (cell: string): string => cell.replace(/`/g, '').trim();

/** `` `A`, `B`, `C` `` -> ['A', 'B', 'C'] */
const items = (cell: string): string[] =>
  bare(cell)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== '—');

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * The table groups labels per row so it stays readable. The handler does the
 * flattening — shape the table for the reader, not for the runner.
 */
verify.table('labels', (row) => {
  const kind = bare(row['Binds to'] as string);

  for (const label of items(row['Label'] as string)) {
    const actual = LABEL_KINDS[label.toLowerCase()];
    assert(actual, `\`${label}\` is documented but is not a recognised label`);
    assert(
      actual === kind,
      `\`${label}\` is documented as binding to ${kind}, but it binds to ${actual}`,
    );
  }
});

verify.table.all('labels', (table) => {
  const documented = table.rows.flatMap((row) =>
    items(row['Label'] as string).map((l) => l.toLowerCase()),
  );

  covers(documented, Object.keys(LABEL_KINDS), {
    noun: 'label',
    missing: (l) => `\`${l}\` is a real label but this page does not list it`,
    extra: (l) => `\`${l}\` is listed here but is not a real label`,
  });
});

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

verify.table('schemaTypes', (row) => {
  const type = bare(row['Type'] as string);
  assert(hasType(type), `\`${type}\` is documented but is not a registered type`);

  for (const alias of items(row['Aliases'] as string)) {
    assert(hasType(alias), `\`${alias}\` is documented as an alias but is not registered`);
  }

  // The documented example must actually be readable as the documented type.
  const example = bare(row['Example'] as string);
  let value: unknown;
  try {
    value = coerce(example, type);
  } catch (err) {
    throw new Error(`the example ${JSON.stringify(example)} does not read as ${type}: ${(err as Error).message}`);
  }

  const becomes = bare(row['Becomes'] as string);
  if (becomes === '—') return; // no stable literal to compare against

  assert(
    JSON.stringify(value) === becomes.replace(/\s+/g, ''),
    `${type} reads ${JSON.stringify(example)} as ${JSON.stringify(value)}, not ${becomes}`,
  );
});

verify.table.all('schemaTypes', (table) => {
  const documented = table.rows.flatMap((row) => [
    bare(row['Type'] as string),
    ...items(row['Aliases'] as string),
  ]);

  covers(documented.map((t) => t.toLowerCase()), knownTypes(), {
    noun: 'type',
    missing: (t) => `\`${t}\` is a registered type but this page does not list it`,
    extra: (t) => `\`${t}\` is listed here but is not registered`,
  });
});

// ---------------------------------------------------------------------------
// Status glyphs
// ---------------------------------------------------------------------------

verify.table('glyphs', (row) => {
  const status = bare(row['Status'] as string) as Status;
  const glyph = (row['Glyph'] as string).trim();

  const actual = STATUS_GLYPH[status];
  assert(actual, `\`${status}\` is documented but is not a status`);

  // Compare without the variation selector: it is invisible and easily lost.
  const strip = (s: string) => s.replace(/️/g, '');
  assert(
    strip(actual) === strip(glyph),
    `${status} is documented as ${glyph} but the runner writes ${actual}`,
  );
});

verify.table.all('glyphs', (table) => {
  covers(
    table.rows.map((row) => bare(row['Status'] as string)),
    Object.keys(STATUS_GLYPH),
    { noun: 'status' },
  );
});
