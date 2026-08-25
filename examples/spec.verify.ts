/**
 * Glue code for `spec.md`.
 *
 * Each `verify.*` call binds an anchor id in the document to a function.
 * Return normally to pass; throw to fail. There is no assertion DSL to learn.
 */
import { verify, assert, covers } from '../src/index.ts';
import {
  allowedTransitions,
  calculateTotal,
  checkNavigation,
  paymentMethod,
  paymentMethodNames,
  taxJurisdictions,
  taxRateFor,
} from './checkout.ts';

/**
 * Called once per data row. Because the anchor declares a `Schema:`, cells
 * arrive already coerced -- `$16.00` is the number `16`, `10%` is `0.1` --
 * reachable by column header or by schema field name.
 */
verify.table('orderTotals', (row) => {
  const actual = calculateTotal(
    row.itemsTotal as number,
    row.shipping as number,
    row.tax as number,
  );

  assert(
    actual === row.total,
    `${row.$raw['Items Total']} + ${row.$raw['Shipping']} @ ${row.$raw['Tax Rate']} ` +
      `should total ${row.$raw['Total Owed']}, got ${actual.toFixed(2)}`,
  );
});

/** Called once per edge in the diagram: is every drawn transition legal? */
verify.mermaid.edges('checkoutFlow', async (edge) => {
  const allowed = await checkNavigation(edge.from, edge.to);
  assert(allowed, `illegal transition: ${edge.from} -> ${edge.to}`);
});

/**
 * Called once with the whole graph: is every legal transition *drawn*?
 *
 * The per-edge handler above can only ever check edges that exist. This is the
 * assertion that catches a transition being added to the code and never making
 * it into the diagram -- the drift that no example-based test can see.
 *
 * `extra` is off because the per-edge handler already owns that direction, and
 * reporting a bad edge twice helps nobody.
 */
verify.mermaid('checkoutFlow', (graph) => {
  covers(
    graph.edges.map((e) => `${e.from} -> ${e.to}`),
    allowedTransitions(),
    {
      noun: 'transition',
      missing: (t) => `${t} is allowed by checkNavigation but is not drawn`,
      extra: false,
    },
  );
});

/** Every supported payment method must be accounted for, either way. */
verify.list.all('settlementRules', (list) => {
  covers(list.items.map((item) => methodName(item.text)), paymentMethodNames(), {
    noun: 'payment method',
    missing: (m) => `${m} is a payment method but no rule documents it`,
    extra: (m) => `${m} is documented but is not a payment method`,
  });
});

/** Called once per list item, nested items included. */
verify.list('settlementRules', (item) => {
  const name = methodName(item.text);
  const method = paymentMethod(name);
  assert(method, `unknown payment method: ${name}`);

  assert(
    method.settlesImmediately === item.checked,
    `${name} settlesImmediately is ${method.settlesImmediately}, but the list says ${item.checked}`,
  );
});

/**
 * Called once with the whole table. Without a `Schema:` line the cells are the
 * raw strings the author typed, which is what you want when the document's
 * formatting is itself part of the contract.
 */
verify.table.all('taxJurisdictions', (table) => {
  assert(
    table.headers.join('|') === 'Code|Jurisdiction|Rate',
    `unexpected columns: ${table.headers.join(', ')}`,
  );

  covers(table.rows.map((r) => r['Code'] as string), taxJurisdictions(), {
    noun: 'jurisdiction',
  });

  for (const row of table.rows) {
    const code = row['Code'] as string;
    const rate = taxRateFor(code);
    assert(rate !== undefined, `no registered rate for ${code}`);

    const documented = Number((row['Rate'] as string).replace('%', '')) / 100;
    assert(
      Math.abs(rate - documented) < 1e-9,
      `${code}: implementation charges ${(rate * 100).toFixed(2)}%, document says ${row['Rate']}`,
    );
  }
});

/** `Card payments settle immediately` -> `card`. */
function methodName(text: string): string {
  const match = /^(\w+) payments settle immediately$/i.exec(text.trim());
  assert(match, `unrecognised rule: ${JSON.stringify(text)}`);
  return match[1]!.toLowerCase();
}
