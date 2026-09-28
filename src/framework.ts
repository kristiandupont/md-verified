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
import { ITEM_ID_RE } from './parser.ts';
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
  /**
   * Set by `verify.list.keyed`: one handler per item id. The runner builds one
   * case per top-level item from it, and `fn` is unused.
   */
  keys?: Readonly<Record<string, ItemHandler>>;
}

/**
 * Keyed by `id:mode`. One anchor may carry both an `each` and an `all`
 * handler -- per-element checks and a whole-asset check such as `covers()`
 * answer different questions about the same table or diagram. Registering the
 * same mode twice is still an error, so typos are still caught.
 */
const registry = new Map<string, Registration>();

function register(
  id: string,
  kind: AnchorKind,
  mode: HandlerMode,
  fn: Function,
  keys?: Registration['keys'],
): void {
  if (typeof id !== 'string' || !id.trim()) {
    throw new TypeError('verify: id must be a non-empty string');
  }
  if (typeof fn !== 'function') {
    throw new TypeError(`verify: handler for \`${id}\` must be a function`);
  }

  const clash = [...registry.values()].find((r) => r.id === id && r.kind !== kind);
  if (clash) {
    throw new Error(
      `verify: \`${id}\` is already registered as verify.${clash.kind}; one anchor cannot be two kinds`,
    );
  }

  const key = `${id}:${mode}`;
  const existing = registry.get(key);
  if (existing) {
    // `list` and `list.keyed` both claim the per-item cases, so say which.
    const name = (r: { keys?: unknown }) => (r.keys ? `${kind}.keyed` : `${kind}.${mode}`);
    throw new Error(
      `verify: \`${id}\` already has a ${name(existing)} handler` +
        (name(existing) === name({ keys }) ? '' : `, so it cannot also have a ${name({ keys })} one`) +
        `.\n` +
        `Anchor ids are unique per *document*, not per project, so two documents may both use \`${id}\`. ` +
        `If that is what happened, load each document with loadDocument() rather than importing their glue files into one process.`,
    );
  }
  registry.set(key, { id, kind, mode, fn: fn as Registration['fn'], ...(keys ? { keys } : {}) });
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
/**
 * Register one handler per item, keyed by the item's `**id**:`.
 *
 * Top-level items only; nested items reach their parent's handler through
 * `item.children`. The list and the handlers must match in both directions:
 * an item with no id, a repeated id, an id with no handler and a handler with
 * no item each fail.
 */
list.keyed = (id: string, handlers: Record<string, ItemHandler>): void => {
  if (!handlers || typeof handlers !== 'object') {
    throw new TypeError(`verify: list.keyed(\`${id}\`) takes an object of handlers keyed by item id`);
  }
  for (const [key, fn] of Object.entries(handlers)) {
    if (!ITEM_ID_RE.test(key)) {
      throw new TypeError(
        `verify: list.keyed(\`${id}\`): \`${key}\` can never match an item; ` +
          `an id is one word of letters, digits, _, . and -`,
      );
    }
    if (typeof fn !== 'function') {
      throw new TypeError(`verify: list.keyed(\`${id}\`): the handler for \`${key}\` must be a function`);
    }
  }
  register(id, 'list', 'each', () => {}, Object.freeze({ ...handlers }));
};

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

/** Every handler bound to an anchor id: at most one `each` and one `all`. */
export function getRegistrations(id: string): Registration[] {
  return [...registry.values()].filter((r) => r.id === id);
}

/** Every registration, in declaration order. */
export function registrations(): Registration[] {
  return [...registry.values()];
}

// Assertions live in `assertions.ts`; re-exported here for convenience.
export { assert, equals, oneOf } from './assertions.ts';
