/**
 * The user-facing API.
 *
 * Glue code registers handlers against the ids used in the Markdown:
 *
 *     verify.table('validateOrder', async (row) => { ... });
 *     verify.mermaid.edges('validateFlow', async (edge) => { ... });
 *
 * A handler either returns normally (pass) or throws (fail). That is the whole
 * contract -- any assertion library works, including none.
 */
import { registerType, type Coercer } from './coerce.ts';
import type {
  AnchorKind,
  AnchorMeta,
  ListItem,
  MermaidEdge,
  MermaidGraph,
  ParsedList,
  ParsedTable,
  TableRow,
} from './types.ts';

/** Second argument to every handler: where in the document we are. */
export interface VerifyContext {
  /** The anchor id. */
  id: string;
  kind: AnchorKind;
  /** The label as written, e.g. `Data`. */
  label: string;
  /** Markdown file the anchor came from. */
  file: string;
  /** 1-based line of the anchor blockquote. */
  line: number;
  /** Extra `**Key:** value` lines from the blockquote. */
  meta: AnchorMeta;
}

export type RowHandler = (row: TableRow, ctx: VerifyContext) => unknown;
export type TableHandler = (table: ParsedTable, ctx: VerifyContext) => unknown;
export type GraphHandler = (graph: MermaidGraph, ctx: VerifyContext) => unknown;
export type EdgeHandler = (edge: MermaidEdge, ctx: VerifyContext) => unknown;
export type ItemHandler = (item: ListItem, ctx: VerifyContext) => unknown;
export type ListHandler = (list: ParsedList, ctx: VerifyContext) => unknown;

/** `each` fans the asset out into one case per row/edge/item. */
export type HandlerMode = 'each' | 'all';

export interface Registration {
  id: string;
  kind: AnchorKind;
  mode: HandlerMode;
  fn: (payload: any, ctx: VerifyContext) => unknown;
}

const registry = new Map<string, Registration>();

function register(id: string, kind: AnchorKind, mode: HandlerMode, fn: Function): void {
  if (typeof id !== 'string' || !id.trim()) {
    throw new TypeError('verify: id must be a non-empty string');
  }
  if (typeof fn !== 'function') {
    throw new TypeError(`verify: handler for \`${id}\` must be a function`);
  }
  const existing = registry.get(id);
  if (existing) {
    throw new Error(
      `verify: \`${id}\` is already registered as ${existing.kind}.${existing.mode}; ids must be unique per run`,
    );
  }
  registry.set(id, { id, kind, mode, fn: fn as Registration['fn'] });
}

/** Register a table handler, called once per data row. */
const table = (id: string, fn: RowHandler): void => register(id, 'table', 'each', fn);
/** Register a table handler, called once with the whole table. */
table.all = (id: string, fn: TableHandler): void => register(id, 'table', 'all', fn);

/** Register a diagram handler, called once with the whole graph. */
const mermaid = (id: string, fn: GraphHandler): void => register(id, 'mermaid', 'all', fn);
/** Register a diagram handler, called once per edge. */
mermaid.edges = (id: string, fn: EdgeHandler): void => register(id, 'mermaid', 'each', fn);

/** Register a list handler, called once per item (nested items included). */
const list = (id: string, fn: ItemHandler): void => register(id, 'list', 'each', fn);
/** Register a list handler, called once with the whole list. */
list.all = (id: string, fn: ListHandler): void => register(id, 'list', 'all', fn);

export const verify = {
  table,
  mermaid,
  list,

  /** Teach `**Schema:**` a new value type. */
  type(name: string, coercer: Coercer): void {
    registerType(name, coercer);
  },

  /** Drop every registration. Mainly for tests that re-import glue code. */
  reset(): void {
    registry.clear();
  },
};

/** Look up the handler bound to an anchor id. */
export function getRegistration(id: string): Registration | undefined {
  return registry.get(id);
}

/** Every registration, in declaration order. */
export function registrations(): Registration[] {
  return [...registry.values()];
}

/** Throw with `message` unless `condition` holds. */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
