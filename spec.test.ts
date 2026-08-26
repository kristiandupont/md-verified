/**
 * `bun test` integration.
 *
 * The interesting part is the first block: the Markdown document is expanded
 * into native Bun tests, one per row / edge / list item, so a failing table row
 * is reported by the test runner with the document line it came from. The rest
 * of the file is ordinary unit coverage for the parsing layers.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { resolve } from 'node:path';

import {
  assert,
  checkReferences,
  checkReviews,
  clearSymbolCache,
  clearReferenceCache,
  coerce,
  covers,
  digestOf,
  equals,
  headingSlugs,
  oneOf,
  findGlueHint,
  parseMarkdown,
  parseMermaid,
  parseSchema,
  loadDocument,
  planCases,
  rewriteMarkdown,
  runParsed,
  verify,
  loadGlue,
  resolveGlue,
  slugify,
} from './src/index.ts';
import { rewriteFromRun } from './src/report.ts';
import type { MermaidGraph, ParsedList, ParsedTable } from './src/index.ts';

const SPEC = 'examples/spec.md';
const BROKEN = 'examples/broken.md';

// ---------------------------------------------------------------------------
// The document, as a test suite
// ---------------------------------------------------------------------------

const source = await Bun.file(SPEC).text();
const parsed = parseMarkdown(source, SPEC);
await loadGlue(resolve(resolveGlue(SPEC, undefined, source)!));

describe('spec.md', () => {
  test('every anchor bound to an asset', () => {
    expect(parsed.problems).toEqual([]);
    expect(parsed.anchors.map((a) => a.id)).toEqual([
      'orderTotals',
      'checkoutFlow',
      'settlementRules',
      'taxJurisdictions',
    ]);
  });

  // One `describe` per anchor, one `test` per case.
  for (const anchor of parsed.anchors) {
    describe(`${anchor.id} (${anchor.kind}, line ${anchor.line})`, () => {
      const plan = planCases(anchor, SPEC);

      if (plan.skipReason) {
        test.skip(plan.skipReason, () => {});
        return;
      }
      if (plan.failReason) {
        test('binds cleanly', () => { throw new Error(plan.failReason!); });
        return;
      }
      for (const kase of plan.cases) {
        test(kase.line ? `${kase.name} — line ${kase.line}` : kase.name, () => kase.run());
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Anchor parsing
// ---------------------------------------------------------------------------

describe('anchor parsing', () => {
  const md = (body: string) => parseMarkdown(body, 't.md');

  test('binds a table by lookahead', () => {
    const r = md('> 🛠️ **Verified Data:** `t`\n\n| A | B |\n| - | - |\n| 1 | 2 |\n');
    expect(r.anchors).toHaveLength(1);
    expect(r.anchors[0]!.kind).toBe('table');
    expect((r.anchors[0]!.data as ParsedTable).headers).toEqual(['A', 'B']);
  });

  test('skips its own comments when looking ahead', () => {
    const r = md(
      '> ❌ **Verified Data:** `t` (Failed)\n\n<!-- ERROR: stale -->\n\n| A |\n| - |\n| 1 |\n',
    );
    expect(r.anchors).toHaveLength(1);
    expect(r.anchors[0]!.status).toBe('failed');
  });

  test('does not skip prose when looking ahead', () => {
    const r = md('> 🛠️ **Verified Data:** `t`\n\nJust a paragraph.\n\n| A |\n| - |\n| 1 |\n');
    expect(r.anchors).toHaveLength(0);
    expect(r.problems[0]!.message).toMatch(/expected a table/);
  });

  test('reports a label that disagrees with the asset', () => {
    const r = md('> 🛠️ **Verified Flow:** `t`\n\n| A |\n| - |\n| 1 |\n');
    expect(r.anchors).toHaveLength(0);
    expect(r.problems[0]!.message).toMatch(/but the next block is a table/);
  });

  test('accepts an anchor with no status glyph', () => {
    const r = md('> **Verified Data:** `t`\n\n| A |\n| - |\n| 1 |\n');
    expect(r.anchors[0]!.status).toBe('pending');
  });

  test('ignores blockquotes that are just callouts', () => {
    const r = md('> **Note:** not an anchor.\n\n| A |\n| - |\n| 1 |\n');
    expect(r.anchors).toHaveLength(0);
    expect(r.problems).toEqual([]);
  });

  test('reads metadata lines', () => {
    const r = md('> 🛠️ **Verified Data:** `t`\n> **Owner:** payments\n\n| A |\n| - |\n| 1 |\n');
    expect(r.anchors[0]!.meta).toEqual({ Owner: 'payments' });
  });
});

// ---------------------------------------------------------------------------
// Tables and schemas
// ---------------------------------------------------------------------------

describe('tables', () => {
  const table = (): ParsedTable =>
    parseMarkdown(
      '> 🛠️ **Verified Data:** `t`\n> **Schema:** `[qty: Integer, price: Currency, rate: Percentage]`\n\n' +
        '| Qty | Unit Price | Tax Rate |\n| --- | ---------- | -------- |\n| 3   | $1,250.50  | 8.5%     |\n',
      't.md',
    ).anchors[0]!.data as ParsedTable;

  test('coerces by header and by schema alias', () => {
    const row = table().rows[0]!;
    expect(row['Qty']).toBe(3);
    expect(row['qty']).toBe(3);
    expect(row['Unit Price']).toBe(1250.5);
    expect(row['price']).toBe(1250.5);
    expect(row['Tax Rate']).toBe(0.085);
  });

  test('keeps the author’s text on $raw', () => {
    const row = table().rows[0]!;
    expect(row.$raw['Unit Price']).toBe('$1,250.50');
    expect(row.$line).toBe(6);
    expect(row.$index).toBe(0);
  });

  test('$-metadata does not show up as data', () => {
    expect(Object.keys(table().rows[0]!)).toEqual([
      'Qty', 'qty', 'Unit Price', 'price', 'Tax Rate', 'rate',
    ]);
  });

  test('a schema whose width disagrees is an anchor defect, not a dropped anchor', () => {
    const r = parseMarkdown(
      '> 🛠️ **Verified Data:** `t`\n> **Schema:** `[a: Integer]`\n\n| A | B |\n| - | - |\n| 1 | 2 |\n',
      't.md',
    );
    // The anchor still binds, so the failure can be written back into the file.
    expect(r.problems).toEqual([]);
    expect(r.anchors).toHaveLength(1);
    expect(r.anchors[0]!.defect).toMatch(/declares 1 field\(s\) but the table has 2/);
  });

  test('a cell that will not coerce defects only its own row', () => {
    const t = parseMarkdown(
      '> 🛠️ **Verified Data:** `t`\n> **Schema:** `[n: Integer]`\n\n| N |\n| - |\n| 1 |\n| abc |\n| 3 |\n',
      't.md',
    ).anchors[0]!.data as ParsedTable;

    expect(t.defects).toEqual([
      { index: 1, line: 7, message: 'column "N": cannot read "abc" as Integer' },
    ]);
    // The good rows survive, and keep their original numbering.
    expect(t.rows.map((r) => r.$index)).toEqual([0, 2]);
    expect(t.rows.map((r) => r['n'])).toEqual([1, 3]);
  });

  test('a defective row fails as a case and never reaches the handler', async () => {
    verify.reset();
    const seen: number[] = [];
    verify.table('rows', (row) => { seen.push(row.$index); });

    const p = parseMarkdown(
      '> 🛠️ **Verified Data:** `rows`\n> **Schema:** `[n: Integer]`\n\n| N |\n| - |\n| 1 |\n| abc |\n',
      't.md',
    );
    const run = await runParsed(p);

    expect(seen).toEqual([0]);
    expect(run.anchors[0]!.status).toBe('failed');
    expect(run.anchors[0]!.cases).toContainEqual(
      expect.objectContaining({ name: 'row 2', status: 'failed', error: expect.stringContaining('cannot read "abc"') }),
    );

    // The whole point of the fix: this now reaches the document.
    const out = rewriteMarkdown(p.source, p.anchors, run.anchors);
    expect(out).toContain('> ❌ **Verified Data:** `rows` (Failed: 1 of 2)');
    expect(out).toContain('<!-- ERROR: row 2: column "N": cannot read "abc" as Integer -->');
  });

  test('a whole-table handler is not run against a table missing rows', async () => {
    verify.reset();
    let called = false;
    verify.table.all('whole', () => { called = true; });

    const p = parseMarkdown(
      '> 🛠️ **Verified Data:** `whole`\n> **Schema:** `[n: Integer]`\n\n| N |\n| - |\n| abc |\n',
      't.md',
    );
    const run = await runParsed(p);

    expect(called).toBe(false);
    expect(run.anchors[0]!.cases.map((x) => x.error)).toContainEqual(
      expect.stringContaining('1 row(s) could not be read'),
    );
  });

  test('an unreadable diagram defects the anchor and is annotated', async () => {
    verify.reset();
    verify.mermaid('flow', () => {});

    const p = parseMarkdown('> 🛠️ **Verified Flow:** `flow`\n\n```mermaid\ngraph TD\n  A -->\n```\n', 't.md');
    expect(p.anchors[0]!.defect).toMatch(/has no target node/);

    const run = await runParsed(p);
    expect(run.anchors[0]!.status).toBe('failed');

    const out = rewriteMarkdown(p.source, p.anchors, run.anchors);
    expect(out).toContain('> ❌ **Verified Flow:** `flow` (Failed)');
    expect(out).toMatch(/<!-- ERROR: .*has no target node.* -->/);
  });

  test('pads short rows, per GFM', () => {
    const t = parseMarkdown(
      '> 🛠️ **Verified Data:** `t`\n\n| A | B |\n| - | - |\n| 1 |\n',
      't.md',
    ).anchors[0]!.data as ParsedTable;
    expect(t.rows[0]!['B']).toBe('');
  });
});

describe('schema syntax', () => {
  test('parses names, types and optionality', () => {
    expect(parseSchema('`[a: Currency, b?: Integer]`')).toEqual([
      { name: 'a', type: 'Currency', optional: false },
      { name: 'b', type: 'Integer', optional: true },
    ]);
  });

  test('requires a type', () => {
    expect(() => parseSchema('[a]')).toThrow(/missing a type/);
  });
});

describe('coercions', () => {
  test.each([
    ['$1,000.00', 'Currency', 1000],
    ['(12.50)', 'Currency', -12.5],
    ['-€8', 'Currency', -8],
    ['10%', 'Percentage', 0.1],
    ['0.25', 'Percentage', 0.25],
    ['42', 'Integer', 42],
    ['yes', 'Boolean', true],
    ['❌', 'Boolean', false],
  ])('%s as %s', (raw, type, expected) => {
    expect(coerce(raw as string, type as string)).toBe(expected);
  });

  test('optional cells become null', () => {
    expect(coerce('', 'Currency', true)).toBeNull();
    expect(coerce('—', 'Integer', true)).toBeNull();
  });

  test('names the known types when one is unrecognised', () => {
    expect(() => coerce('1', 'Furlong')).toThrow(/unknown type; known types:/);
  });
});

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

describe('mermaid', () => {
  test('reads nodes, labels and edges', () => {
    const g = parseMermaid('graph TD\n  Cart[Cart Page] --> Shipping[Shipping Info]');
    expect(g.direction).toBe('TD');
    expect(g.node('Cart')!.label).toBe('Cart Page');
    expect(g.edges).toEqual([
      expect.objectContaining({ from: 'Cart', to: 'Shipping', directed: true, style: 'normal' }),
    ]);
  });

  test('treats `A --- B --- C` as two open links, not a label', () => {
    const g = parseMermaid('graph LR\n  A --- B --- C');
    expect(g.edges.map((e) => `${e.from}-${e.to}`)).toEqual(['A-B', 'B-C']);
    expect(g.edges.every((e) => !e.directed)).toBe(true);
    expect(g.edges.every((e) => e.label === null)).toBe(true);
  });

  test('reads both label syntaxes', () => {
    const g = parseMermaid('graph LR\n  A -- yes --> B\n  A -->|no| C\n  C -.retry.-> A');
    expect(g.edges.map((e) => e.label)).toEqual(['yes', 'no', 'retry']);
    expect(g.edges[2]!.style).toBe('dotted');
  });

  test('expands `&` into a cross product', () => {
    const g = parseMermaid('graph TD\n  A & B --> C');
    expect(g.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['A->C', 'B->C']);
  });

  test('tracks subgraph membership', () => {
    const g = parseMermaid('graph TD\n subgraph auth[Auth]\n  L --> V\n end\n V --> Home');
    expect(g.node('L')!.subgraph).toBe('auth');
    expect(g.node('Home')!.subgraph).toBeNull();
    expect(g.subgraphs[0]!.label).toBe('Auth');
  });

  test('ignores styling and comments', () => {
    const g = parseMermaid('graph TD\n %% note\n A --> B %% trailing\n style A fill:#f9f\n click A "x"');
    expect(g.edges).toHaveLength(1);
  });

  test('answers reachability questions', () => {
    const g = parseMermaid('graph TD\n A --> B\n B --> C');
    expect(g.hasEdge('A', 'B')).toBe(true);
    expect(g.hasEdge('A', 'C')).toBe(false);
    expect(g.hasPath('A', 'C')).toBe(true);
    expect(g.roots().map((n) => n.id)).toEqual(['A']);
    expect(g.leaves().map((n) => n.id)).toEqual(['C']);
  });

  test('rejects a dangling link', () => {
    expect(() => parseMermaid('graph TD\n A -->')).toThrow(/has no target node/);
  });
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

describe('lists', () => {
  const list = parseMarkdown(
    '> 🛠️ **Verified Rules:** `r`\n\n- [x] one\n- [ ] two\n  - nested\n',
    't.md',
  ).anchors[0]!.data as ParsedList;

  test('reads checkbox state', () => {
    expect(list.items.map((i) => i.checked)).toEqual([true, false]);
    expect(list.items[0]!.text).toBe('one');
  });

  test('keeps nesting and flattens in document order', () => {
    expect(list.items[1]!.children[0]!.text).toBe('nested');
    expect(list.flat.map((i) => i.text)).toEqual(['one', 'two', 'nested']);
    expect(list.flat[2]!.depth).toBe(1);
    expect(list.flat[2]!.checked).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bi-directional state reporting
// ---------------------------------------------------------------------------

const brokenSource = await Bun.file(BROKEN).text();

describe('state reporting', () => {
  const runBroken = async () => {
    verify.reset();
    await loadGlue(resolve('examples/spec.verify.ts'));
    const p = parseMarkdown(brokenSource, BROKEN);
    const run = await runParsed(p);
    return { p, run };
  };

  test('a drifted document fails', async () => {
    const { run } = await runBroken();
    expect(run.ok).toBe(false);
    expect(run.summary.failed).toBe(4);
    expect(run.summary.casesFailed).toBe(7);
  });

  test('marks failures and records the error inline', async () => {
    const { p, run } = await runBroken();
    const out = rewriteMarkdown(brokenSource, p.anchors, run.anchors);

    expect(out).toContain('> ❌ **Verified Flow:** `checkoutFlow` (Failed: 2 of 5)');
    expect(out).toContain('<!-- ERROR: Cart -> Payment: illegal transition: Cart -> Payment -->');
    expect(out).toContain('> ❌ **Verified Data:** `orderTotals` (Failed: 2 of 3)');
    expect(out).toMatch(/<!-- ERROR: row 1: .*should total \$15\.00, got 16\.00 -->/);
  });

  test('leaves everything else byte-for-byte alone', async () => {
    const { p, run } = await runBroken();
    const out = rewriteMarkdown(brokenSource, p.anchors, run.anchors);

    // The assets themselves, and all prose, must survive untouched.
    expect(out).toContain('| $10.00      | $5.00    | 10%      | $15.00     |');
    expect(out).toContain('    Cart[Cart Page] --> Shipping[Shipping Info]');
    const fence = (text: string) => {
      const start = text.indexOf('```mermaid');
      return text.slice(start, text.indexOf('```', start + 10) + 3);
    };
    expect(fence(out)).toBe(fence(brokenSource));
  });

  test('is idempotent — annotating twice changes nothing', async () => {
    const { p, run } = await runBroken();
    const once = rewriteMarkdown(brokenSource, p.anchors, run.anchors);

    verify.reset();
    await loadGlue(resolve('examples/spec.verify.ts'));
    const p2 = parseMarkdown(once, BROKEN);
    const run2 = await runParsed(p2);
    const twice = rewriteMarkdown(once, p2.anchors, run2.anchors);

    expect(twice).toBe(once);
    expect(run2.summary.casesFailed).toBe(7);
  });

  test('a passing run clears the marks a failing run left', async () => {
    const { p, run } = await runBroken();
    const annotated = rewriteMarkdown(brokenSource, p.anchors, run.anchors);

    // Same document, but pretend every anchor now passes.
    const p2 = parseMarkdown(annotated, BROKEN);
    const green = p2.anchors.map((a) => ({
      id: a.id, kind: a.kind, label: a.label, line: a.line,
      status: 'passed' as const, reason: null, cases: [],
    }));
    const out = rewriteMarkdown(annotated, p2.anchors, green);

    expect(out).not.toContain('<!-- ERROR:');
    expect(out).not.toContain('(Failed');
    expect(out).toContain('> ✅ **Verified Flow:** `checkoutFlow`');
  });

  test('--reset returns the document to its unrun state', async () => {
    const { p, run } = await runBroken();
    const annotated = rewriteMarkdown(brokenSource, p.anchors, run.anchors);

    const p2 = parseMarkdown(annotated, BROKEN);
    const out = rewriteMarkdown(annotated, p2.anchors, [], { reset: true });

    expect(out).toBe(brokenSource);
  });

  test('an error message cannot break out of its comment', async () => {
    verify.reset();
    verify.table('evil', () => {
      throw new Error('closes early --> and opens <!-- again\n\nacross lines');
    });
    const p = parseMarkdown('> 🛠️ **Verified Data:** `evil`\n\n| A |\n| - |\n| 1 |\n', 'e.md');
    const run = await runParsed(p, { links: false });
    const out = rewriteMarkdown(p.source, p.anchors, run.anchors);

    const comments = out.match(/<!--[\s\S]*?-->/g) ?? [];
    expect(comments).toHaveLength(1);

    // The delimiters must appear exactly once each, at the edges, and the body
    // must contain no blank line -- a blank line would end the HTML block and
    // spill the rest of the message into the document as visible text.
    const body = comments[0]!.slice('<!--'.length, -'-->'.length);
    expect(body).not.toContain('-->');
    expect(body).not.toContain('<!--');
    expect(body).not.toMatch(/\n\s*\n/);

    // And it must still parse as a single comment the tool owns.
    const again = parseMarkdown(out, 'e.md');
    expect(again.anchors).toHaveLength(1);
    expect(again.problems).toEqual([]);
  });

  test('a multi-line message keeps its shape in the document', async () => {
    verify.reset();
    verify.table('multi', () => {
      throw new Error('expect(received).toBe(expected)\n\nExpected: 15\nReceived: 16');
    });
    const p = parseMarkdown('> 🛠️ **Verified Data:** `multi`\n\n| A |\n| - |\n| 1 |\n', 'm.md');
    const run = await runParsed(p, { links: false });
    const out = rewriteMarkdown(p.source, p.anchors, run.anchors);

    expect(out).toContain('<!-- ERROR: row 1: expect(received).toBe(expected)');
    expect(out).toContain('     Expected: 15');
    expect(out).toContain('     Received: 16 -->');
  });

  test('a very long message is truncated rather than flooding the file', async () => {
    verify.reset();
    verify.table('long', () => {
      throw new Error(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'));
    });
    const p = parseMarkdown('> 🛠️ **Verified Data:** `long`\n\n| A |\n| - |\n| 1 |\n', 'l.md');
    const run = await runParsed(p, { links: false });
    const out = rewriteMarkdown(p.source, p.anchors, run.anchors);

    expect(out).toContain('more line(s)');
    expect(out.split('\n').filter((l) => l.includes('line ')).length).toBeLessThan(10);
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('registry', () => {
  test('rejects the same mode twice', () => {
    verify.reset();
    verify.table('dup', () => {});
    expect(() => verify.table('dup', () => {})).toThrow(/already has a table.each handler/);
  });

  test('rejects one id bound to two kinds', () => {
    verify.reset();
    verify.table('two', () => {});
    expect(() => verify.mermaid('two', () => {})).toThrow(/already registered as verify.table/);
  });

  test('accepts an each and an all handler on one anchor', async () => {
    verify.reset();
    const seen: string[] = [];
    verify.table('both', (row) => { seen.push(`each:${row.$index}`); });
    verify.table.all('both', (table) => { seen.push(`all:${table.rows.length}`); });

    const p = parseMarkdown('> 🛠️ **Verified Data:** `both`\n\n| A |\n| - |\n| 1 |\n| 2 |\n', 't.md');
    const run = await runParsed(p);

    expect(run.anchors[0]!.status).toBe('passed');
    expect(seen).toEqual(['each:0', 'each:1', 'all:2']);
    expect(run.anchors[0]!.cases.map((x) => x.name)).toEqual(['row 1', 'row 2', 'whole table']);
  });

  test('skips an anchor with no handler', async () => {
    verify.reset();
    const p = parseMarkdown('> 🛠️ **Verified Data:** `nobody`\n\n| A |\n| - |\n| 1 |\n', 't.md');
    const run = await runParsed(p);

    expect(run.anchors[0]!.status).toBe('skipped');
    expect(run.anchors[0]!.reason).toMatch(/no handler registered/);
    expect(run.ok).toBe(true);
  });

  test('fails an anchor whose handler is the wrong kind', async () => {
    verify.reset();
    verify.mermaid('wrongKind', () => {});
    const p = parseMarkdown('> 🛠️ **Verified Data:** `wrongKind`\n\n| A |\n| - |\n| 1 |\n', 't.md');
    const run = await runParsed(p);

    expect(run.anchors[0]!.status).toBe('failed');
    expect(run.anchors[0]!.reason).toMatch(/registered as verify\.mermaid/);
  });

  test('custom types reach the schema layer', async () => {
    verify.reset();
    verify.type('Sku', (raw) => {
      if (!/^[A-Z]{3}-\d{3}$/.test(raw)) throw new Error(`bad SKU: ${raw}`);
      return raw;
    });
    const p = parseMarkdown(
      '> 🛠️ **Verified Data:** `s`\n> **Schema:** `[sku: Sku]`\n\n| SKU |\n| --- |\n| ABC-123 |\n',
      't.md',
    );
    expect((p.anchors[0]!.data as ParsedTable).rows[0]!['sku']).toBe('ABC-123');
  });

  test('an async handler that rejects is a failure', async () => {
    verify.reset();
    verify.table('slow', async () => {
      await Bun.sleep(1);
      throw new Error('nope');
    });
    const p = parseMarkdown('> 🛠️ **Verified Data:** `slow`\n\n| A |\n| - |\n| 1 |\n', 't.md');
    const run = await runParsed(p);
    expect(run.anchors[0]!.cases[0]!.error).toBe('nope');
  });

  test('a hung handler times out', async () => {
    verify.reset();
    verify.table('hang', () => new Promise(() => {}));
    const p = parseMarkdown('> 🛠️ **Verified Data:** `hang`\n\n| A |\n| - |\n| 1 |\n', 't.md');
    const run = await runParsed(p, { timeout: 25 });
    expect(run.anchors[0]!.cases[0]!.error).toMatch(/timed out after 25ms/);
  });
});

// ---------------------------------------------------------------------------
// covers(): set assertions
// ---------------------------------------------------------------------------

describe('covers', () => {
  test('passes when the sets match, in any order', () => {
    expect(() => covers(['b', 'a'], ['a', 'b'])).not.toThrow();
  });

  test('reports what the document is missing', () => {
    expect(() => covers(['a'], ['a', 'b', 'c'])).toThrow('missing entry: b; missing entry: c');
  });

  test('reports what the document invented', () => {
    expect(() => covers(['a', 'z'], ['a'])).toThrow('unexpected entry: z');
  });

  test('reports both directions at once', () => {
    expect(() => covers(['a', 'z'], ['a', 'b'])).toThrow(
      'missing entry: b; unexpected entry: z',
    );
  });

  test('uses custom messages and a noun', () => {
    expect(() =>
      covers([], ['transfer'], {
        noun: 'method',
        missing: (m) => `${m} exists but is undocumented`,
      }),
    ).toThrow('transfer exists but is undocumented');

    expect(() => covers([], ['x'], { noun: 'widget' })).toThrow('missing widget: x');
  });

  test('either direction can be switched off', () => {
    expect(() => covers(['a'], ['a', 'b'], { missing: false })).not.toThrow();
    expect(() => covers(['a', 'z'], ['a'], { extra: false })).not.toThrow();
  });

  test('flags a key the document lists twice', () => {
    expect(() => covers(['a', 'a'], ['a'])).toThrow('duplicate entry: a (listed 2 times)');
    expect(() => covers(['a', 'a'], ['a'], { duplicates: false })).not.toThrow();
  });

  test('catches drift the per-element handler cannot see', async () => {
    verify.reset();
    // Every documented row is correct, but one is absent entirely.
    verify.table('rates', (row) => {
      expect(['DK', 'DE']).toContain(row['Code'] as string);
    });
    verify.table.all('rates', (table) => {
      covers(table.rows.map((r) => r['Code'] as string), ['DK', 'DE', 'GB'], { noun: 'country' });
    });

    const p = parseMarkdown(
      '> 🛠️ **Verified Data:** `rates`\n\n| Code |\n| ---- |\n| DK |\n| DE |\n',
      't.md',
    );
    const run = await runParsed(p, { links: false });

    expect(run.anchors[0]!.cases.filter((x) => x.status === 'passed')).toHaveLength(2);
    expect(run.anchors[0]!.cases.find((x) => x.status === 'failed')).toMatchObject({
      name: 'whole table',
      error: 'missing country: GB',
    });
  });
});

// ---------------------------------------------------------------------------
// Reference checking
// ---------------------------------------------------------------------------

describe('references', () => {
  const fixture = async (body: string, fn: (path: string) => Promise<void>) => {
    const path = `examples/.tmp-ref-${Math.random().toString(36).slice(2)}.md`;
    await Bun.write(path, body);
    clearReferenceCache();
    try {
      await fn(path);
    } finally {
      await Bun.file(path).delete();
      clearReferenceCache();
    }
  };

  const check = async (body: string) => {
    let problems: Awaited<ReturnType<typeof checkReferences>> = [];
    await fixture(body, async (path) => {
      problems = await checkReferences(parseMarkdown(await Bun.file(path).text(), path));
    });
    return problems;
  };

  test('accepts a link to a file that exists', async () => {
    expect(await check('See [code](./checkout.ts).\n')).toEqual([]);
  });

  test('flags a link to a file that does not', async () => {
    const [p] = await check('See [the appendix](./nope.md).\n');
    expect(p!.message).toBe('broken link: ./nope.md (no such file)');
    expect(p!.line).toBe(1);
    expect(p!.column).toBe(5);
  });

  test('leaves external links alone', async () => {
    expect(await check('[a](https://example.com) [b](mailto:x@y.z) [c](//cdn/x.js)\n')).toEqual([]);
  });

  test('checks a fragment-linked symbol, and suggests a near miss', async () => {
    const [p] = await check('[`calculateTotals`](./checkout.ts#calculateTotals)\n');
    expect(p!.message).toBe(
      'broken symbol: ./checkout.ts#calculateTotals (no export named `calculateTotals`) (did you mean `calculateTotal`?)',
    );
  });

  test('accepts a symbol that exists', async () => {
    expect(await check('[fn](./checkout.ts#calculateTotal)\n')).toEqual([]);
  });

  test('symbol checking can be switched off', async () => {
    let problems: Awaited<ReturnType<typeof checkReferences>> = [];
    await fixture('[x](./checkout.ts#nope)\n', async (path) => {
      problems = await checkReferences(parseMarkdown(await Bun.file(path).text(), path), {
        symbols: false,
      });
    });
    expect(problems).toEqual([]);
  });

  test('checks in-document anchors', async () => {
    expect(await check('# Order Totals\n\n[go](#order-totals)\n')).toEqual([]);

    const [p] = await check('# Order Totals\n\n[go](#order-total)\n');
    expect(p!.message).toBe('broken anchor: #order-total (did you mean `order-totals`?)');
  });

  test('checks anchors into another markdown file', async () => {
    expect(await check('[x](./spec.md#settlement)\n')).toEqual([]);
    const [p] = await check('[x](./spec.md#nonexistent-heading)\n');
    expect(p!.message).toMatch(/broken anchor: \.\/spec\.md#nonexistent-heading \(no such heading\)/);
  });

  test('accepts a reference whose definition resolves', async () => {
    expect(await check('See [the thing][ok].\n\n[ok]: ./checkout.ts\n')).toEqual([]);
  });

  test('flags a definition pointing at a missing file', async () => {
    const [p] = await check('See [the thing][ok].\n\n[ok]: ./nope.md\n');
    expect(p!.message).toBe('broken link: ./nope.md (no such file)');
    expect(p!.line).toBe(3);
  });

  test('a reference with no definition is invisible to the AST', async () => {
    // CommonMark leaves `[x][missing]` as literal text, so there is no node to
    // flag -- but a reader sees the broken brackets, which is its own warning.
    expect(await check('See [the thing][missing].\n')).toEqual([]);
  });

  test('checks images too', async () => {
    const [p] = await check('![diagram](./missing.png)\n');
    expect(p!.message).toBe('broken link: ./missing.png (no such file)');
  });

  test('a broken reference makes the run fail', async () => {
    await fixture('[gone](./nope.md)\n', async (path) => {
      verify.reset();
      const run = await runParsed(parseMarkdown(await Bun.file(path).text(), path));
      expect(run.ok).toBe(false);
      expect(run.problems[0]!.message).toMatch(/broken link/);
    });
  });

  test('in-memory documents are not link checked', async () => {
    const p = parseMarkdown('[gone](./nope.md)\n', '<memory>');
    expect(await checkReferences(p)).toEqual([]);
  });
});

describe('heading slugs', () => {
  test('matches GitHub for punctuation and case', () => {
    expect(slugify('Order Totals')).toBe('order-totals');
    expect(slugify('Tax & Fees (2024)')).toBe('tax--fees-2024');
    expect(slugify('  Spaced   Out  ')).toBe('spaced---out');
  });

  test('disambiguates repeated headings', () => {
    const tree = parseMarkdown('# Notes\n\n# Notes\n\n# Notes\n', 't.md').tree;
    expect([...headingSlugs(tree)]).toEqual(['notes', 'notes-1', 'notes-2']);
  });

  test('reads through inline formatting', () => {
    const tree = parseMarkdown('## The `covers` helper\n', 't.md').tree;
    expect([...headingSlugs(tree)]).toEqual(['the-covers-helper']);
  });
});

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

describe('assertions', () => {
  test('equals passes on matching values', () => {
    expect(() => equals(16, 16)).not.toThrow();
    expect(() => equals('a', 'a')).not.toThrow();
    expect(() => equals([1, 2], [1, 2])).not.toThrow();
    expect(() => equals({ a: 1 }, { a: 1 })).not.toThrow();
    expect(() => equals(new Date('2026-01-01'), new Date('2026-01-01'))).not.toThrow();
  });

  test('equals reads as documentation, on one line', () => {
    expect(() => equals(15, 16, 'total')).toThrow('total: expected 16, got 15');
    expect(() => equals(15, 16)).toThrow('expected 16, got 15');
    expect(() => equals('b', 'a', 'tier')).toThrow('tier: expected "a", got "b"');
  });

  test('equals compares objects structurally', () => {
    expect(() => equals({ a: 1 }, { a: 2 })).toThrow('expected {"a":2}, got {"a":1}');
  });

  test('equals truncates a value too large for a line', () => {
    const big = { text: 'x'.repeat(200) };
    const message = (() => {
      try { equals(big, null); return ''; } catch (err) { return (err as Error).message; }
    })();
    expect(message).toContain('…');
    expect(message.length).toBeLessThan(160);
    expect(message).not.toContain('\n');
  });

  test('oneOf names the options', () => {
    expect(() => oneOf('active', ['active', 'paused'])).not.toThrow();
    expect(() => oneOf('archived', ['active', 'paused'], 'status')).toThrow(
      'status: "archived" is not one of active, paused',
    );
  });

  test('assert stays the escape hatch', () => {
    expect(() => assert(false, 'shipping is never taxed')).toThrow('shipping is never taxed');
    expect(() => assert(true, 'nope')).not.toThrow();
  });

  test('a third-party assertion library still works', async () => {
    verify.reset();
    verify.table('third', () => {
      // Anything that throws is a failure; that contract is not going away.
      expect(1).toBe(2);
    });
    const p = parseMarkdown('> 🛠️ **Verified Data:** `third`\n\n| A |\n| - |\n| 1 |\n', 't.md');
    const run = await runParsed(p, { links: false });
    expect(run.anchors[0]!.status).toBe('failed');
    expect(run.anchors[0]!.cases[0]!.error).toContain('expect');
  });
});

// ---------------------------------------------------------------------------
// Reviews: staleness for the prose that cannot be executed
// ---------------------------------------------------------------------------

describe('reviews', () => {
  let n = 0;
  /** A throwaway module + document pair, cleaned up afterwards. */
  const scratch = async (
    moduleSource: string,
    docBody: (mod: string) => string,
    fn: (ctx: { doc: string; mod: string; edit: (s: string) => Promise<void> }) => Promise<void>,
  ) => {
    const tag = `${process.pid}-${n++}`;
    const mod = `examples/.tmp-mod-${tag}.ts`;
    const doc = `examples/.tmp-doc-${tag}.md`;
    await Bun.write(mod, moduleSource);
    await Bun.write(doc, docBody(`./.tmp-mod-${tag}.ts`));
    clearSymbolCache();
    try {
      await fn({
        doc,
        mod,
        edit: async (next) => { await Bun.write(mod, next); clearSymbolCache(); },
      });
    } finally {
      await Bun.file(mod).delete();
      await Bun.file(doc).delete();
      clearSymbolCache();
    }
  };

  const MODULE = [
    'export function covered(a: number) {',
    '  return a + 1;',
    '}',
    '',
    'export const UNRELATED = 1;',
    '',
  ].join('\n');

  const docWith = (extra = '') => (mod: string) =>
    ['# Thing', '', '> 👁️ **Reviewed:** `thing`', `> **Covers:** \`${mod}#covered\``, extra, '', 'Some prose.', '']
      .filter((l) => l !== null)
      .join('\n');

  const run = async (doc: string) => {
    const parsed = parseMarkdown(await Bun.file(doc).text(), doc);
    return { parsed, result: await runParsed(parsed, { links: false }) };
  };

  test('parses covers and digest off the blockquote', async () => {
    await scratch(MODULE, docWith('> **Digest:** `abc123`'), async ({ doc }) => {
      const { parsed } = await run(doc);
      expect(parsed.reviews).toHaveLength(1);
      expect(parsed.reviews[0]!.id).toBe('thing');
      expect(parsed.reviews[0]!.covers[0]).toMatch(/#covered$/);
      expect(parsed.reviews[0]!.digest).toBe('abc123');
    });
  });

  test('an unstamped review fails and asks to be stamped', async () => {
    await scratch(MODULE, docWith(), async ({ doc }) => {
      const { result } = await run(doc);
      expect(result.ok).toBe(false);
      expect(result.reviews[0]!.status).toBe('failed');
      expect(result.reviews[0]!.reason).toMatch(/never stamped/);
    });
  });

  test('--stamp records the digest and clears the note', async () => {
    await scratch(MODULE, docWith(), async ({ doc }) => {
      const { parsed, result } = await run(doc);
      const out = rewriteFromRun(result, parsed, { stamp: true });

      expect(out).toContain('> ✅ **Reviewed:** `thing`');
      expect(out).toMatch(/> \*\*Digest:\*\* `1:[0-9a-f]{12}`/);
      expect(out).not.toContain('<!-- REVIEW:');
    });
  });

  test('a stamped review is current', async () => {
    await scratch(MODULE, docWith(), async ({ doc }) => {
      const first = await run(doc);
      await Bun.write(doc, rewriteFromRun(first.result, first.parsed, { stamp: true }));

      const { result } = await run(doc);
      expect(result.reviews[0]!.status).toBe('passed');
      expect(result.ok).toBe(true);
    });
  });

  test('an unrelated edit in the same file does not fire', async () => {
    await scratch(MODULE, docWith(), async ({ doc, edit }) => {
      const first = await run(doc);
      await Bun.write(doc, rewriteFromRun(first.result, first.parsed, { stamp: true }));

      // Touch a different export entirely.
      await edit(MODULE.replace('export const UNRELATED = 1;', 'export const UNRELATED = 99;'));

      const { result } = await run(doc);
      expect(result.reviews[0]!.status).toBe('passed');
    });
  });

  test('editing the covered symbol makes it stale, and says so in the file', async () => {
    await scratch(MODULE, docWith(), async ({ doc, edit }) => {
      const first = await run(doc);
      await Bun.write(doc, rewriteFromRun(first.result, first.parsed, { stamp: true }));

      await edit(MODULE.replace('return a + 1;', 'return a + 2;'));

      const { parsed, result } = await run(doc);
      expect(result.reviews[0]!.status).toBe('failed');
      expect(result.ok).toBe(false);

      const out = rewriteFromRun(result, parsed);
      expect(out).toContain('**Reviewed:** `thing` (Stale)');
      expect(out).toMatch(/<!-- REVIEW: .*changed since this section was last read.*-->/);
    });
  });

  test('rewriting a stale review twice is idempotent', async () => {
    await scratch(MODULE, docWith(), async ({ doc, edit }) => {
      const first = await run(doc);
      await Bun.write(doc, rewriteFromRun(first.result, first.parsed, { stamp: true }));
      await edit(MODULE.replace('return a + 1;', 'return a + 3;'));

      const second = await run(doc);
      const once = rewriteFromRun(second.result, second.parsed);
      await Bun.write(doc, once);

      const third = await run(doc);
      expect(rewriteFromRun(third.result, third.parsed)).toBe(once);
    });
  });

  test('--write never stamps: an attestation must be deliberate', async () => {
    await scratch(MODULE, docWith(), async ({ doc }) => {
      const { parsed, result } = await run(doc);
      const out = rewriteFromRun(result, parsed, { stamp: false });
      expect(out).not.toContain('**Digest:**');
    });
  });

  test('covering something that does not exist fails clearly', async () => {
    await scratch(MODULE, (mod) =>
      ['> 👁️ **Reviewed:** `x`', `> **Covers:** \`${mod}#nope\``, '', 'Prose.', ''].join('\n'),
    async ({ doc }) => {
      const { result } = await run(doc);
      expect(result.reviews[0]!.reason).toMatch(/exports no `nope`/);
    });

    await scratch(MODULE, () =>
      ['> 👁️ **Reviewed:** `x`', '> **Covers:** `./gone.ts`', '', 'Prose.', ''].join('\n'),
    async ({ doc }) => {
      const { result } = await run(doc);
      expect(result.reviews[0]!.reason).toMatch(/does not exist/);
    });
  });

  test('a review that covers nothing is a defect', async () => {
    await scratch(MODULE, () => ['> 👁️ **Reviewed:** `x`', '', 'Prose.', ''].join('\n'),
    async ({ doc }) => {
      const { result } = await run(doc);
      expect(result.reviews[0]!.reason).toMatch(/declares no \*\*Covers:\*\* targets/);
    });
  });

  test('a whole-file target is honoured, and is more sensitive', async () => {
    await scratch(MODULE, (mod) =>
      ['> 👁️ **Reviewed:** `x`', `> **Covers:** \`${mod}\``, '', 'Prose.', ''].join('\n'),
    async ({ doc, edit }) => {
      const first = await run(doc);
      await Bun.write(doc, rewriteFromRun(first.result, first.parsed, { stamp: true }));

      // The same unrelated edit that a symbol target ignores.
      await edit(MODULE.replace('export const UNRELATED = 1;', 'export const UNRELATED = 99;'));

      const { result } = await run(doc);
      expect(result.reviews[0]!.status).toBe('failed');
    });
  });

  test('--reset clears the stamp', async () => {
    await scratch(MODULE, docWith(), async ({ doc }) => {
      const first = await run(doc);
      const stamped = rewriteFromRun(first.result, first.parsed, { stamp: true });
      await Bun.write(doc, stamped);

      const second = await run(doc);
      const out = rewriteFromRun(second.result, second.parsed, { reset: true });
      expect(out).not.toContain('**Digest:**');
      expect(out).toContain('> 👁️ **Reviewed:** `thing`');
    });
  });

  test('the digest ignores line endings', async () => {
    const body = 'export function f() {\n  return 1;\n}\n';
    await scratch(body, docWith(), async ({ doc, mod, edit }) => {
      void mod;
      const parsed = parseMarkdown(await Bun.file(doc).text(), doc);
      // docWith covers `#covered`; this fixture exports `f`, so target the file.
      const covers = parsed.reviews[0]!.covers.map((cover) => cover.split('#')[0]!);
      const dir = 'examples';

      const lf = digestOf(covers, dir);
      await edit(body.replace(/\n/g, '\r\n'));
      const crlf = digestOf(covers, dir);

      expect(lf).toBe(crlf);
    });
  });

  test('the digest carries a format version', async () => {
    await scratch(MODULE, docWith(), async ({ doc }) => {
      const { result } = await run(doc);
      expect(result.reviews[0]!.digest).toMatch(/^1:[0-9a-f]{12}$/);
    });
  });

  test('an older-format stamp says so, rather than blaming the code', async () => {
    await scratch(MODULE, docWith('> **Digest:** `deadbeefcafe`'), async ({ doc }) => {
      const { result } = await run(doc);
      expect(result.reviews[0]!.reason).toMatch(/older digest format/);
      expect(result.reviews[0]!.reason).not.toMatch(/changed since/);
    });
  });

  test('review checking can be switched off', async () => {
    await scratch(MODULE, docWith(), async ({ doc }) => {
      const parsed = parseMarkdown(await Bun.file(doc).text(), doc);
      expect(checkReviews(parsed, { reviews: false })).toEqual([]);

      const result = await runParsed(parsed, { links: false, reviews: false });
      expect(result.ok).toBe(true);
    });
  });

  test('a document of prose and reviews needs no glue code', async () => {
    await scratch(MODULE, docWith(), async ({ doc }) => {
      const proc = Bun.spawn(['bun', 'run', 'check.ts', doc], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' },
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      expect(stderr).not.toContain('no glue code found');
      expect(stdout).toContain('never stamped');
    });
  });
});

describe('loadDocument', () => {
  test('two documents may share an anchor id', async () => {
    const seen: string[] = [];
    (globalThis as any).__seen = seen;

    const docs = ['examples/.tmp-a.md', 'examples/.tmp-b.md'];
    const glue = ['examples/.tmp-a.verify.ts', 'examples/.tmp-b.verify.ts'];

    // `prices` is not an unusual id. Both documents use it.
    await Bun.write(docs[0]!, '<!-- verify: ./.tmp-a.verify.ts -->\n\n> 🛠️ **Verified Data:** `prices`\n\n| T |\n| - |\n| a |\n');
    await Bun.write(docs[1]!, '<!-- verify: ./.tmp-b.verify.ts -->\n\n> 🛠️ **Verified Data:** `prices`\n\n| T |\n| - |\n| b |\n');
    await Bun.write(glue[0]!, "import { verify } from '../src/index.ts';\nverify.table('prices', (row) => { (globalThis as any).__seen.push('A:' + row['T']); });\n");
    await Bun.write(glue[1]!, "import { verify } from '../src/index.ts';\nverify.table('prices', (row) => { (globalThis as any).__seen.push('B:' + row['T']); });\n");

    try {
      const a = await loadDocument(docs[0]!, { links: false });
      const b = await loadDocument(docs[1]!, { links: false });

      // Loading B resets the registry; A's cases must still hold their own
      // handler, and must not have been rebound to B's.
      for (const c of a.suites[0]!.cases) await c.run();
      for (const c of b.suites[0]!.cases) await c.run();

      expect(seen).toEqual(['A:a', 'B:b']);
    } finally {
      for (const f of [...docs, ...glue]) await Bun.file(f).delete();
      delete (globalThis as any).__seen;
    }
  });

  test('reports references and reviews alongside the cases', async () => {
    const doc = 'examples/.tmp-c.md';
    await Bun.write(doc, '# C\n\n[gone](./nowhere.md)\n');
    try {
      const loaded = await loadDocument(doc);
      expect(loaded.suites).toEqual([]);
      expect(loaded.problems[0]!.message).toMatch(/broken link/);
    } finally {
      await Bun.file(doc).delete();
    }
  });

  test('a document with anchors but no glue fails loudly', async () => {
    const doc = 'examples/.tmp-d.md';
    await Bun.write(doc, '> 🛠️ **Verified Data:** `x`\n\n| A |\n| - |\n| 1 |\n');
    try {
      expect(loadDocument(doc, { links: false })).rejects.toThrow(/no glue code found/);
    } finally {
      await Bun.file(doc).delete();
    }
  });
});

describe('interleaved anchors and reviews', () => {
  test('rewriting a document containing both leaves each intact', async () => {
    verify.reset();
    verify.table('t', () => {});

    // The review sits *before* the anchor. Rewriting them in two passes
    // shifted the anchor's offsets and shredded its blockquote.
    const src = [
      '# Doc',
      '',
      '> 👁️ **Reviewed:** `r`',
      '> **Covers:** `./checkout.ts#calculateTotal`',
      '',
      'Some prose.',
      '',
      '> 🛠️ **Verified Data:** `t`',
      '> **Schema:** `[n: Integer]`',
      '',
      '| N |',
      '| - |',
      '| 1 |',
      '',
    ].join('\n');

    const doc = 'examples/.tmp-interleaved.md';
    await Bun.write(doc, src);
    try {
      const parsed = parseMarkdown(await Bun.file(doc).text(), doc);
      const run = await runParsed(parsed, { links: false });

      for (const opts of [{}, { stamp: true }, { reset: true }]) {
        const out = rewriteFromRun(run, parsed, opts);
        expect(out).toContain('**Verified Data:** `t`');
        expect(out).toContain('> **Schema:** `[n: Integer]`');
        expect(out).toContain('**Reviewed:** `r`');
        expect(out).toContain('| N |');
        // The blockquote must stay one contiguous block.
        expect(out).not.toMatch(/>\s*\n\n\*\*\s*\n/);
      }
    } finally {
      await Bun.file(doc).delete();
    }
  });

  test('stamping a review does not disturb anchors after it', async () => {
    verify.reset();
    verify.table('t', () => {});

    const src = [
      '> 👁️ **Reviewed:** `r`',
      '> **Covers:** `./checkout.ts#calculateTotal`',
      '',
      'Prose.',
      '',
      '> 🛠️ **Verified Data:** `t`',
      '',
      '| N |',
      '| - |',
      '| 1 |',
      '',
    ].join('\n');

    const doc = 'examples/.tmp-stamp-order.md';
    await Bun.write(doc, src);
    try {
      const parsed = parseMarkdown(await Bun.file(doc).text(), doc);
      const run = await runParsed(parsed, { links: false });
      const out = rewriteFromRun(run, parsed, { stamp: true });

      // Re-parsing the result must find both, still bound.
      const again = parseMarkdown(out, doc);
      expect(again.reviews).toHaveLength(1);
      expect(again.anchors).toHaveLength(1);
      expect(again.anchors[0]!.id).toBe('t');
      expect(again.problems).toEqual([]);
    } finally {
      await Bun.file(doc).delete();
    }
  });
});

describe('glue hints', () => {
  test('a hint in prose is found', () => {
    expect(findGlueHint('# X\n\n<!-- verify: ./real.ts -->\n')).toBe('./real.ts');
  });

  test('a hint shown as an example in a code fence is not', () => {
    const doc = ['# Docs', '', '```markdown', '<!-- verify: ./x.verify.ts -->', '```', ''].join('\n');
    expect(findGlueHint(doc)).toBeNull();
  });

  test('a real hint still wins when an example appears first', () => {
    const doc = [
      '```markdown',
      '<!-- verify: ./example.ts -->',
      '```',
      '',
      '<!-- verify: ./real.ts -->',
      '',
    ].join('\n');
    expect(findGlueHint(doc)).toBe('./real.ts');
  });
});

describe('comment ownership', () => {
  test("a rewrite never deletes the author's glue hint", async () => {
    verify.reset();
    verify.table('t', () => {});
    // The hint sits in the gap the rewriter owns.
    const src = '> 🛠️ **Verified Data:** `t`\n\n<!-- verify: ./glue.ts -->\n\n| A |\n| - |\n| 1 |\n';

    const p = parseMarkdown(src, 't.md');
    const run = await runParsed(p, { links: false });
    const out = rewriteMarkdown(src, p.anchors, run.anchors);

    expect(out).toContain('<!-- verify: ./glue.ts -->');
    expect(p.anchors).toHaveLength(1); // and the hint did not break the binding
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe('cli', () => {
  const run = async (args: string[]) => {
    const proc = Bun.spawn(['bun', 'run', 'check.ts', ...args], {
      stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  };

  test('exits 0 on a passing document', async () => {
    const r = await run([SPEC]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('4 passed');
  });

  test('exits 1 on a drifted document', async () => {
    const r = await run([BROKEN]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('4 failed');
  });

  test('--json emits parseable results', async () => {
    const r = await run([BROKEN, '--json']);
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(false);
    expect(data.files[0].anchors.find((a: any) => a.id === 'checkoutFlow').cases)
      .toContainEqual(expect.objectContaining({
        name: 'Cart -> Payment',
        status: 'failed',
        error: 'illegal transition: Cart -> Payment',
      }));
  });

  test('--only narrows the run', async () => {
    const r = await run([BROKEN, '--only', 'checkoutFlow', '--json']);
    const data = JSON.parse(r.stdout);
    const statuses = data.files[0].anchors.map((a: any) => a.status);
    expect(statuses.filter((s: string) => s === 'failed')).toHaveLength(1);
    expect(statuses.filter((s: string) => s === 'skipped')).toHaveLength(3);
  });

  test('--json carries reference problems', async () => {
    const r = await run([BROKEN, '--json']);
    const messages = JSON.parse(r.stdout).files[0].problems.map((x: any) => x.message);
    expect(messages).toContainEqual(expect.stringContaining('broken symbol: ./checkout.ts#calculateTotals'));
    expect(messages).toContainEqual('broken link: ./appendix.md (no such file)');
  });

  test('--no-links skips reference checking', async () => {
    const r = await run([BROKEN, '--no-links', '--json']);
    expect(JSON.parse(r.stdout).files[0].problems).toEqual([]);
  });

  test('a clean document with symbol links passes end to end', async () => {
    const r = await run([SPEC, '--json']);
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(true);
    expect(data.files[0].problems).toEqual([]);
  });

  test('expands globs itself, so quoting one is safe', async () => {
    const r = await run(['examples/spec*.md', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).files.map((f: any) => f.file)).toEqual(['examples/spec.md']);
  });

  test('a glob that matches nothing fails rather than passing quietly', async () => {
    const r = await run(['examples/*.markdown']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no files match examples/*.markdown');
  });

  test('a missing file is named, and fails', async () => {
    const r = await run(['examples/nope.md']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('examples/nope.md: no such file');
  });

  test('glue that throws on import names the glue file and the document', async () => {
    const doc = 'examples/.tmp-badglue.md';
    const glue = 'examples/.tmp-badglue.verify.ts';
    await Bun.write(doc, '> 🛠️ **Verified Data:** `x`\n\n| A |\n| - |\n| 1 |\n');
    await Bun.write(glue, "throw new Error('boom during import');\n");
    try {
      const r = await run([doc, SPEC]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`${doc}: glue file ${glue} failed to load: boom during import`);
      // The healthy document is still reported.
      expect(r.stdout).toContain('4 passed');
    } finally {
      await Bun.file(doc).delete();
      await Bun.file(glue).delete();
    }
  });

  test('--stamp exits 0 once it has resolved what it stamped', async () => {
    const doc = 'examples/.tmp-stampexit.md';
    await Bun.write(doc, [
      '# S', '',
      '> 👁️ **Reviewed:** `r`',
      '> **Covers:** `./checkout.ts#calculateTotal`',
      '', 'Prose.', '',
    ].join('\n'));
    try {
      // Without --stamp the unstamped review fails.
      expect((await run([doc])).code).toBe(1);
      // Stamping resolves it, so complaining about it afterwards would be
      // complaining about the thing the command just fixed.
      const stamped = await run([doc, '--stamp']);
      expect(stamped.code).toBe(0);
      expect(stamped.stdout).toContain('1/1 reviews current');
      expect(await Bun.file(doc).text()).toMatch(/\*\*Digest:\*\* `1:/);
    } finally {
      await Bun.file(doc).delete();
    }
  });

  test('--stamp still fails on a review it cannot fix', async () => {
    const doc = 'examples/.tmp-stampbad.md';
    await Bun.write(doc, '# S\n\n> 👁️ **Reviewed:** `r`\n> **Covers:** `./gone.ts`\n\nProse.\n');
    try {
      const r = await run([doc, '--stamp']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('does not exist');
    } finally {
      await Bun.file(doc).delete();
    }
  });

  test('--covering searches **/*.md when given no documents', async () => {
    const r = await run(['--covering', 'src/parser.ts']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('docs/anchor-reference.md');
    expect(r.stdout).toContain('binding');
  });

  test('--covering says how many documents it searched when it finds none', async () => {
    const r = await run(['--covering', 'src/covers.ts']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/No review covers src\/covers\.ts \(searched \d+ documents\)/);
  });

  test('--write annotates the file in place', async () => {
    const tmp = 'examples/.tmp-write.md';
    await Bun.write(tmp, (await Bun.file(BROKEN).text()));
    try {
      const r = await run([tmp, '--glue', 'examples/spec.verify.ts', '--write']);
      expect(r.code).toBe(1);
      const after = await Bun.file(tmp).text();
      expect(after).toContain('> ❌ **Verified Data:** `orderTotals` (Failed: 2 of 3)');
      expect(after).toContain('<!-- ERROR:');
    } finally {
      await Bun.file(tmp).delete();
    }
  });
});
