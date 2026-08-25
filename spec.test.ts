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
  coerce,
  parseMarkdown,
  parseMermaid,
  parseSchema,
  planCases,
  rewriteMarkdown,
  runParsed,
  verify,
  loadGlue,
  resolveGlue,
} from './src/index.ts';
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

  test('rejects a schema whose width disagrees with the table', () => {
    const r = parseMarkdown(
      '> 🛠️ **Verified Data:** `t`\n> **Schema:** `[a: Integer]`\n\n| A | B |\n| - | - |\n| 1 | 2 |\n',
      't.md',
    );
    expect(r.problems[0]!.message).toMatch(/declares 1 field\(s\) but the table has 2/);
  });

  test('reports the cell that failed to coerce', () => {
    const r = parseMarkdown(
      '> 🛠️ **Verified Data:** `t`\n> **Schema:** `[n: Integer]`\n\n| N |\n| - |\n| abc |\n',
      't.md',
    );
    expect(r.problems[0]!.message).toMatch(/cannot read "abc" as Integer/);
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
    expect(run.summary.casesFailed).toBe(5);
  });

  test('marks failures and records the error inline', async () => {
    const { p, run } = await runBroken();
    const out = rewriteMarkdown(brokenSource, p.anchors, run.anchors);

    expect(out).toContain('> ❌ **Verified Flow:** `checkoutFlow` (Failed: 1 of 4)');
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
    expect(run2.summary.casesFailed).toBe(5);
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
      throw new Error('closes early --> and opens <!-- again\nacross lines');
    });
    const p = parseMarkdown('> 🛠️ **Verified Data:** `evil`\n\n| A |\n| - |\n| 1 |\n', 'e.md');
    const run = await runParsed(p);
    const out = rewriteMarkdown(p.source, p.anchors, run.anchors);

    const comments = out.match(/<!--[\s\S]*?-->/g) ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]).not.toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('registry', () => {
  test('rejects a duplicate id', () => {
    verify.reset();
    verify.table('dup', () => {});
    expect(() => verify.mermaid('dup', () => {})).toThrow(/already registered/);
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
