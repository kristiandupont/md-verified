/**
 * Markdown -> anchors.
 *
 * An *anchor* is a blockquote of the form
 *
 *     > 🛠️ **Verified Data:** `validateOrder`
 *     > **Schema:** `[itemsTotal: Currency, total: Currency]`
 *
 * immediately followed by a native Markdown asset -- a table, a Mermaid code
 * block, or a list. The blockquote renders as an ordinary callout everywhere;
 * nothing here requires a custom renderer.
 *
 * Binding is done by *lookahead*: we take the next block-level node, skipping
 * only the HTML comments this framework writes itself (so a file that has
 * already been annotated with `<!-- ERROR: ... -->` still binds correctly on
 * the next run).
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import type { Nodes, Root, RootContent } from 'mdast';

import { gfmTableFromMarkdown, gfmTaskListItemFromMarkdown } from './mdast-gfm.ts';
import { coerce } from './coerce.ts';
import { parseMermaid } from './mermaid.ts';
import {
  KNOWN_GLYPHS,
  STATUS_GLYPH,
  type Anchor,
  type AnchorKind,
  type AnchorMeta,
  type ListItem,
  type ParsedList,
  type ParsedTable,
  type ParseProblem,
  type ParseResult,
  type RowDefect,
  type SchemaField,
  type Status,
  type TableRow,
} from './types.ts';

/** First line of an anchor: optional glyph, bold label, backticked id. */
const ANCHOR_RE =
  /^\s*(?:(?<status>[^\s*`]+)\s+)?\*\*\s*Verified\s+(?<label>[A-Za-z][A-Za-z0-9 _-]*?)\s*:?\s*\*\*\s*:?\s*`(?<id>[^`]+)`\s*(?<rest>.*)$/u;

/** Subsequent lines: `**Key:** value`. */
const META_RE =
  /^\s*\*\*\s*(?<key>[A-Za-z][A-Za-z0-9 _-]*?)\s*:?\s*\*\*\s*:?\s*(?<value>.*)$/u;

/** Comments this framework owns and is free to rewrite. */
export const MANAGED_COMMENT_RE = /^<!--\s*(?:ERROR|VERIFY)\b/i;

/** Human labels -> the asset kind they bind to. */
const LABEL_KINDS: Record<string, AnchorKind> = {
  data: 'table',
  table: 'table',
  rows: 'table',
  examples: 'table',
  cases: 'table',
  dataset: 'table',
  matrix: 'table',

  flow: 'mermaid',
  diagram: 'mermaid',
  graph: 'mermaid',
  mermaid: 'mermaid',
  flowchart: 'mermaid',
  states: 'mermaid',
  sequence: 'mermaid',

  list: 'list',
  steps: 'list',
  rules: 'list',
  checklist: 'list',
  items: 'list',
};

/** Optional pointer to glue code: `<!-- verify: ./spec.verify.ts -->`. */
const GLUE_HINT_RE = /<!--\s*verify(?:-glue)?:\s*(?<path>[^\s>]+?)\s*-->/i;

export function parseMarkdown(source: string, file = '<memory>'): ParseResult {
  const tree = fromMarkdown(source, {
    extensions: [gfmTable(), gfmTaskListItem()],
    mdastExtensions: [gfmTableFromMarkdown(), gfmTaskListItemFromMarkdown()],
  }) as Root;

  const anchors: Anchor[] = [];
  const problems: ParseProblem[] = [];
  const children = tree.children;

  for (let i = 0; i < children.length; i++) {
    const node = children[i]!;
    if (node.type !== 'blockquote') continue;

    const lines = quoteLines(source, node);
    const head = ANCHOR_RE.exec(lines[0] ?? '');
    if (!head) continue;

    const line = node.position!.start.line;
    const id = head.groups!.id!.trim();
    const label = head.groups!.label!.trim();
    const declared = LABEL_KINDS[label.toLowerCase()] ?? null;
    const status = statusFromGlyph(head.groups!.status);
    const meta = parseMeta(lines.slice(1));

    // Lookahead: the next block node, skipping comments we wrote ourselves.
    let j = i + 1;
    while (j < children.length && isManagedComment(children[j]!)) j++;
    const target = children[j];

    if (!target) {
      problems.push({ id, line, message: `anchor \`${id}\` has nothing after it to verify` });
      continue;
    }

    const actual = kindOfNode(target);
    if (!actual) {
      problems.push({
        id,
        line,
        message: `anchor \`${id}\` is followed by a ${describe(target)}; expected a table, a mermaid code block, or a list`,
      });
      continue;
    }
    if (declared && declared !== actual) {
      problems.push({
        id,
        line,
        message: `anchor \`${id}\` says "Verified ${label}" (a ${declared}) but the next block is a ${actual}`,
      });
      continue;
    }

    // An asset we cannot read is a *defect*, not a reason to drop the anchor:
    // the anchor still binds, still fails, and still gets annotated, which is
    // the whole point of writing state back into the document.
    let data: Anchor['data'];
    let defect: string | null = null;
    try {
      data = extract(source, target, actual, meta);
    } catch (err) {
      defect = (err as Error).message;
      data = emptyData(actual);
    }

    anchors.push({
      id,
      kind: actual,
      label,
      status,
      meta,
      defect,
      data,
      line,
      quoteRange: { start: node.position!.start.offset!, end: node.position!.end.offset! },
      targetRange: { start: target.position!.start.offset!, end: target.position!.end.offset! },
      gapRange: { start: node.position!.end.offset!, end: target.position!.start.offset! },
    });

    i = j - 1; // resume scanning just before the bound target
  }

  return { file, source, tree, anchors, problems };
}

/** Read a `<!-- verify: ./glue.ts -->` hint, if the document carries one. */
export function findGlueHint(source: string): string | null {
  return GLUE_HINT_RE.exec(source)?.groups?.path ?? null;
}

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

function extract(
  source: string,
  node: RootContent,
  kind: AnchorKind,
  meta: AnchorMeta,
): Anchor['data'] {
  if (kind === 'table') return extractTable(source, node as any, meta);
  if (kind === 'mermaid') return parseMermaid((node as any).value ?? '');
  return extractList(source, node as any);
}

function extractTable(source: string, node: any, meta: AnchorMeta): ParsedTable {
  const rows = node.children ?? [];
  if (rows.length === 0) throw new Error('table has no header row');

  const headers = (rows[0].children ?? []).map((cell: any) => cellText(source, cell));
  const align = (node.align ?? []).map((a: string | null) =>
    a === 'left' || a === 'right' || a === 'center' ? a : null,
  );

  const schema = meta.Schema ? parseSchema(meta.Schema) : null;
  if (schema && schema.length !== headers.length) {
    throw new Error(
      `schema declares ${schema.length} field(s) but the table has ${headers.length} column(s)`,
    );
  }

  const dataRows: TableRow[] = [];
  const defects: RowDefect[] = [];

  for (let r = 1; r < rows.length; r++) {
    const cells: string[] = (rows[r].children ?? []).map((cell: any) => cellText(source, cell));
    // GFM pads short rows and drops extra cells.
    while (cells.length < headers.length) cells.push('');
    cells.length = headers.length;

    const raw: Record<string, string> = {};
    const row: Record<string, unknown> = {};
    let failure: string | null = null;

    headers.forEach((header: string, c: number) => {
      const text = cells[c]!;
      raw[header] = text;

      const field = schema?.[c];
      let value: unknown = text;
      if (field) {
        try {
          value = coerce(text, field.type, field.optional);
        } catch (err) {
          // Record the first bad cell and keep the raw text, so the row is
          // reported once rather than once per column.
          failure ??= `column ${JSON.stringify(header)}: ${(err as Error).message}`;
        }
      }

      row[header] = value;
      // Schema field names are aliases onto the same coerced value.
      if (field && field.name !== header) row[field.name] = value;
    });

    const line = rows[r].position?.start.line ?? 0;

    if (failure) {
      // A row we cannot trust never reaches a handler.
      defects.push({ index: r - 1, line, message: failure });
      continue;
    }

    define(row, '$index', r - 1);
    define(row, '$line', line);
    define(row, '$raw', Object.freeze(raw));
    define(row, '$cells', Object.freeze(cells));
    define(row, '$headers', Object.freeze([...headers]));

    dataRows.push(row as TableRow);
  }

  return { headers, align, rows: dataRows, defects, schema };
}

function extractList(source: string, node: any): ParsedList {
  const flat: ListItem[] = [];

  const walk = (list: any, depth: number): ListItem[] =>
    (list.children ?? []).map((li: any, index: number) => {
      const nested = (li.children ?? []).filter((c: any) => c.type === 'list');
      const body = (li.children ?? []).filter((c: any) => c.type !== 'list');

      const text = body
        .map((c: any) => source.slice(c.position.start.offset, c.position.end.offset))
        .join('\n')
        .trim();

      const item: ListItem = {
        text,
        checked: typeof li.checked === 'boolean' ? li.checked : null,
        depth,
        index,
        line: li.position?.start.line ?? 0,
        children: nested.flatMap((n: any) => walk(n, depth + 1)),
      };
      flat.push(item);
      return item;
    });

  const items = walk(node, 0);
  // `flat` is built depth-first as a side effect; re-sort into document order.
  flat.sort((a, b) => a.line - b.line);

  return { ordered: Boolean(node.ordered), items, flat };
}

/** `[itemsTotal: Currency, tax: Percentage]` -> fields. */
export function parseSchema(raw: string): SchemaField[] {
  let text = raw.trim().replace(/^`+|`+$/g, '').trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);

  return splitTopLevel(text)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(':');
      if (idx === -1) {
        throw new Error(`schema field ${JSON.stringify(part)} is missing a type (want "name: Type")`);
      }
      let name = part.slice(0, idx).trim();
      const type = part.slice(idx + 1).trim();

      const optional = name.endsWith('?');
      if (optional) name = name.slice(0, -1).trim();

      if (!name) throw new Error(`schema field ${JSON.stringify(part)} is missing a name`);
      if (!type) throw new Error(`schema field ${JSON.stringify(name)} is missing a type`);
      return { name, type, optional };
    });
}

/** Split on commas that are not nested inside brackets. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of text) {
    if ('[({<'.includes(ch)) depth++;
    else if ('])}>'.includes(ch)) depth--;

    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/** A safe placeholder for an anchor whose asset could not be read. */
function emptyData(kind: AnchorKind): Anchor['data'] {
  if (kind === 'table') return { headers: [], align: [], rows: [], defects: [], schema: null };
  if (kind === 'list') return { ordered: false, items: [], flat: [] };
  return parseMermaid('');
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Blockquote source with the `>` markers stripped, one entry per line. */
function quoteLines(source: string, node: Nodes): string[] {
  const raw = source.slice(node.position!.start.offset!, node.position!.end.offset!);
  return raw.split('\n').map((l) => l.replace(/^\s*>\s?/, ''));
}

function parseMeta(lines: string[]): AnchorMeta {
  const meta: AnchorMeta = {};
  for (const line of lines) {
    const m = META_RE.exec(line);
    if (!m) continue;
    meta[m.groups!.key!.trim()] = m.groups!.value!.trim();
  }
  return meta;
}

function statusFromGlyph(glyph: string | undefined): Status {
  if (!glyph) return 'pending';
  const bare = glyph.replace(/️/g, '');
  for (const [status, g] of Object.entries(STATUS_GLYPH)) {
    if (g.replace(/️/g, '') === bare) return status as Status;
  }
  return 'pending';
}

function isManagedComment(node: RootContent): boolean {
  return node.type === 'html' && MANAGED_COMMENT_RE.test(node.value.trim());
}

function kindOfNode(node: RootContent): AnchorKind | null {
  if (node.type === 'table') return 'table';
  if (node.type === 'list') return 'list';
  if (node.type === 'code' && (node.lang ?? '').toLowerCase() === 'mermaid') return 'mermaid';
  return null;
}

function describe(node: RootContent): string {
  if (node.type === 'code') return `${node.lang ?? 'plain'} code block`;
  return `${node.type} block`;
}

function cellText(source: string, cell: any): string {
  const start = cell?.position?.start?.offset;
  const end = cell?.position?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number') return '';

  // Cell tokens span their delimiters; strip the outer pipes but leave any
  // escaped `\|` inside the content alone.
  let text = source.slice(start, end);
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  return text.trim();
}

/** Attach `$`-prefixed metadata without polluting `Object.keys(row)`. */
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: false, writable: false });
}

export { KNOWN_GLYPHS };
