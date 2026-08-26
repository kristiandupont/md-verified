/** Shared vocabulary for the whole framework. */
import type { Root } from 'mdast';

/** The three kinds of native Markdown asset an anchor can bind to. */
export type AnchorKind = 'table' | 'mermaid' | 'list';

/** Lifecycle of a single anchor or case. */
export type Status = 'pending' | 'passed' | 'failed' | 'skipped';

/** The glyph that leads an anchor's blockquote, per status. */
export const STATUS_GLYPH: Record<Status, string> = {
  pending: '\u{1F6E0}️', // hammer and wrench
  passed: '✅', // white heavy check mark
  failed: '❌', // cross mark
  skipped: '⚠️', // warning sign
};

/** An unstamped review, analogous to the pending hammer on an anchor. */
export const REVIEW_PENDING_GLYPH = '\u{1F441}\uFE0F';

/** Every glyph we recognise as "this is a status marker", incl. bare variants. */
export const KNOWN_GLYPHS = new Set([
  '\u{1F6E0}️',
  '\u{1F6E0}',
  '✅',
  '❌',
  '⚠️',
  '⚠',
  '\u{1F441}\uFE0F',
  '\u{1F441}',
]);

/** Human-facing parenthetical appended after the anchor id. */
export const STATUS_SUFFIX: Record<Status, string> = {
  pending: '',
  passed: '',
  failed: '(Failed)',
  skipped: '(Skipped)',
};

/** A source position, 1-based lines/columns as mdast reports them. */
export interface Point {
  line: number;
  column: number;
  offset: number;
}

/** A single parsed table row, handed to `verify.table` callbacks. */
export interface TableRow {
  /** Coerced value by header name *and* by schema field name. */
  [key: string]: unknown;
  /** Zero-based index among data rows. */
  readonly $index: number;
  /** 1-based line in the source file. */
  readonly $line: number;
  /** Untouched cell text, keyed by header. */
  readonly $raw: Readonly<Record<string, string>>;
  /** Untouched cell text, in column order. */
  readonly $cells: readonly string[];
  /** Header labels, in column order. */
  readonly $headers: readonly string[];
}

/** A row that could not be built, e.g. a cell that failed to coerce. */
export interface RowDefect {
  /** Zero-based index the row would have had among data rows. */
  index: number;
  /** 1-based line in the source file. */
  line: number;
  message: string;
}

/** A whole parsed table. */
export interface ParsedTable {
  headers: string[];
  /** Column alignment as declared in the delimiter row. */
  align: Array<'left' | 'right' | 'center' | null>;
  /** Rows that were built successfully. Defective rows are absent. */
  rows: TableRow[];
  /**
   * Rows that could not be built. These are reported as failing cases rather
   * than handed to a handler, so a bad cell never reaches glue code.
   */
  defects: RowDefect[];
  /** Declared schema, if the anchor carried a `**Schema:**` line. */
  schema: SchemaField[] | null;
}

/** One `name: Type` pair from a `**Schema:**` declaration. */
export interface SchemaField {
  name: string;
  type: string;
  /** Trailing `?` marks the column as optional / nullable. */
  optional: boolean;
}

/** A bullet or ordered list item. */
export interface ListItem {
  /** Item text with Markdown inline syntax preserved. */
  text: string;
  /** `true` / `false` for `- [x]` / `- [ ]` items, `null` otherwise. */
  checked: boolean | null;
  /** Nesting depth, 0 at the top level. */
  depth: number;
  /** Zero-based index among siblings. */
  index: number;
  /** 1-based line in the source file. */
  line: number;
  children: ListItem[];
}

/** A whole parsed list. */
export interface ParsedList {
  ordered: boolean;
  /** Top-level items; nested items hang off `children`. */
  items: ListItem[];
  /** Every item at every depth, in document order. */
  flat: ListItem[];
}

/** Metadata lines parsed out of the anchor blockquote, e.g. `**Schema:**`. */
export type AnchorMeta = Record<string, string>;

/** An anchor: the blockquote plus the asset it points at. */
export interface Anchor {
  /** The `id` from the backticks, e.g. `validateOrder`. */
  id: string;
  /** Resolved kind, from the label and confirmed by the target node. */
  kind: AnchorKind;
  /** The human-facing label as written, e.g. `Data`, `Flow`. */
  label: string;
  /** Status glyph found in the source. */
  status: Status;
  meta: AnchorMeta;
  /**
   * An anchor-level problem that makes the asset unusable -- a malformed
   * schema, an unparseable diagram. The anchor is still returned so the runner
   * can fail it and write the reason back into the document; `data` is an
   * empty placeholder and is never handed to a handler.
   */
  defect: string | null;
  /** Parsed payload: shape depends on `kind`. */
  data: ParsedTable | MermaidGraph | ParsedList;
  /** 1-based line of the blockquote's first line. */
  line: number;
  /** Byte range of the blockquote itself. */
  quoteRange: { start: number; end: number };
  /** Byte range of the asset the anchor binds to. */
  targetRange: { start: number; end: number };
  /** Byte range of everything between them (comments live here). */
  gapRange: { start: number; end: number };
}

/**
 * A claim that a human has read this section against the code behind it.
 *
 * Prose and rationale cannot be executed. What *can* be checked is whether
 * anyone has looked at them since the code they describe last changed -- an
 * attestation rather than a proof, which is the honest thing to offer for the
 * parts of a document that matter most and verify least.
 */
export interface Review {
  id: string;
  status: Status;
  /** Paths, relative to the document, optionally `#symbol`-qualified. */
  covers: string[];
  /** The digest recorded at the last review, if any. */
  digest: string | null;
  /** A malformed review, e.g. one that declares nothing to cover. */
  defect: string | null;
  meta: AnchorMeta;
  line: number;
  quoteRange: { start: number; end: number };
  gapRange: { start: number; end: number };
}

/** The outcome of checking one review. */
export interface ReviewResult {
  id: string;
  line: number;
  status: Exclude<Status, 'pending'>;
  reason: string | null;
  /** The digest as it is now. Written back by `--stamp`. */
  digest: string | null;
  /** Whether the recorded digest matched. */
  current: boolean;
}

/** A structural problem found while parsing -- reported like a failure. */
export interface ParseProblem {
  id: string | null;
  line: number;
  /** 1-based column, when the diagnostic points at something inline. */
  column?: number;
  message: string;
}

export interface ParseResult {
  file: string;
  source: string;
  /** The mdast tree, kept so passes like reference checking can reuse it. */
  tree: Root;
  anchors: Anchor[];
  reviews: Review[];
  problems: ParseProblem[];
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

export type MermaidShape =
  | 'rect'
  | 'round'
  | 'stadium'
  | 'subroutine'
  | 'cylinder'
  | 'circle'
  | 'doublecircle'
  | 'diamond'
  | 'hexagon'
  | 'parallelogram'
  | 'parallelogram-alt'
  | 'trapezoid'
  | 'trapezoid-alt'
  | 'asymmetric';

export interface MermaidNode {
  id: string;
  /** Display label; falls back to the id when the node is bare. */
  label: string;
  shape: MermaidShape;
  /** Id of the enclosing `subgraph`, when there is one. */
  subgraph: string | null;
}

export type EdgeStyle = 'normal' | 'thick' | 'dotted' | 'invisible';

export interface MermaidEdge {
  from: string;
  to: string;
  /** Edge label, from `-->|text|` or `-- text -->`. */
  label: string | null;
  style: EdgeStyle;
  /** `false` for open links like `A --- B`. */
  directed: boolean;
  /** The link as written, e.g. `-->`. */
  raw: string;
}

export interface MermaidSubgraph {
  id: string;
  label: string;
  nodes: string[];
}

export interface MermaidGraph {
  /** `graph`, `flowchart`, or whatever the header declared. */
  type: string;
  /** `TD`, `LR`, ... Defaults to `TB` when the header omits it. */
  direction: string;
  nodes: MermaidNode[];
  edges: MermaidEdge[];
  subgraphs: MermaidSubgraph[];
  /** The original diagram source. */
  raw: string;

  /** Look a node up by id. */
  node(id: string): MermaidNode | undefined;
  /** Edges leaving `id`. */
  from(id: string): MermaidEdge[];
  /** Edges entering `id`. */
  to(id: string): MermaidEdge[];
  /** Is there a direct edge `a -> b`? */
  hasEdge(a: string, b: string): boolean;
  /** Is `b` reachable from `a` by following directed edges? */
  hasPath(a: string, b: string): boolean;
  /** Nodes with no incoming edges. */
  roots(): MermaidNode[];
  /** Nodes with no outgoing edges. */
  leaves(): MermaidNode[];
}

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

/** One executed case: a row, an edge, an item, or a whole asset. */
export interface CaseResult {
  /** Short human label, e.g. `row 2` or `Cart -> Payment`. */
  name: string;
  status: Exclude<Status, 'pending'>;
  /** Failure message, or `null` when the case passed. */
  error: string | null;
  stack: string | null;
  durationMs: number;
  /** 1-based source line the case came from, when known. */
  line: number | null;
}

/** Everything that happened for a single anchor. */
export interface AnchorResult {
  id: string;
  kind: AnchorKind;
  label: string;
  line: number;
  status: Exclude<Status, 'pending'>;
  /** Why an anchor was skipped, or how it failed structurally. */
  reason: string | null;
  cases: CaseResult[];
}

export interface RunSummary {
  anchors: number;
  reviews: number;
  reviewsStale: number;
  passed: number;
  failed: number;
  skipped: number;
  cases: number;
  casesPassed: number;
  casesFailed: number;
  durationMs: number;
}

export interface RunResult {
  file: string;
  ok: boolean;
  source: string;
  anchors: AnchorResult[];
  reviews: ReviewResult[];
  problems: ParseProblem[];
  summary: RunSummary;
}
