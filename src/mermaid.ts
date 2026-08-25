/**
 * A small, dependency-free Mermaid flowchart parser.
 *
 * Scope is deliberately the flowchart/graph family (and anything else built
 * from `A --> B` statements, such as `stateDiagram-v2`). It resolves the one
 * genuinely ambiguous piece of the grammar the same way Mermaid's own lexer
 * does: a *complete* link is matched greedily before a link-with-label is
 * considered, so `A --- B --- C` is two open links rather than one link
 * labelled `B`.
 */
import type {
  EdgeStyle,
  MermaidEdge,
  MermaidGraph,
  MermaidNode,
  MermaidShape,
  MermaidSubgraph,
} from './types.ts';

/** Raised for diagram source we cannot make sense of. */
export class MermaidParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message} (diagram line ${line})`);
    this.name = 'MermaidParseError';
  }
}

/** A complete link: `-->`, `---`, `==>`, `-.->`, `~~~`. */
const FULL_LINK = /^(?<lhead>[xo<])?(?<stem>-{2,}[-xo>]|={2,}[=xo>]|-\.+-[xo>]?|~{3,})/;
/** The opening half of a labelled link: `-- text -->`. */
const OPEN_LINK = /^(?<lhead>[xo<])?(?<stem>-{2,}|={2,}|-\.+)/;
/** The closing half of a labelled link. */
const CLOSE_LINK = /^(?<stem>-{2,}|={2,}|\.+-)(?<rhead>[xo>])?/;
/** `-->|label|` */
const PIPE_LABEL = /^\|(?<label>[^|]*)\|/;

/** Shapes, longest delimiter first so `((x))` wins over `(x)`. */
const SHAPES: Array<[RegExp, MermaidShape]> = [
  [/^\(\(\((?<label>[\s\S]*?)\)\)\)/, 'doublecircle'],
  [/^\(\((?<label>[\s\S]*?)\)\)/, 'circle'],
  [/^\{\{(?<label>[\s\S]*?)\}\}/, 'hexagon'],
  [/^\[\[(?<label>[\s\S]*?)\]\]/, 'subroutine'],
  [/^\[\((?<label>[\s\S]*?)\)\]/, 'cylinder'],
  [/^\(\[(?<label>[\s\S]*?)\]\)/, 'stadium'],
  [/^\[\/(?<label>[\s\S]*?)\/\]/, 'parallelogram'],
  [/^\[\\(?<label>[\s\S]*?)\\\]/, 'parallelogram-alt'],
  [/^\[\/(?<label>[\s\S]*?)\\\]/, 'trapezoid'],
  [/^\[\\(?<label>[\s\S]*?)\/\]/, 'trapezoid-alt'],
  [/^\[(?<label>[\s\S]*?)\]/, 'rect'],
  [/^\((?<label>[\s\S]*?)\)/, 'round'],
  [/^\{(?<label>[\s\S]*?)\}/, 'diamond'],
  [/^>(?<label>[\s\S]*?)\]/, 'asymmetric'],
];

const NODE_ID = /^(?:"(?<quoted>[^"]+)"|(?<bare>[A-Za-z0-9_][A-Za-z0-9_.:-]*))/;

/** Statement keywords that carry styling, not structure. */
const IGNORED = /^(?:style|classDef|class|click|linkStyle|direction|accTitle|accDescr)\b/;

interface Cursor {
  text: string;
  pos: number;
  line: number;
}

export function parseMermaid(source: string): MermaidGraph {
  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];
  const subgraphs: MermaidSubgraph[] = [];
  const stack: MermaidSubgraph[] = [];

  let type = 'graph';
  let direction = 'TB';
  let headerSeen = false;

  const statements = splitStatements(source);

  for (const stmt of statements) {
    const text = stmt.text;

    if (!headerSeen) {
      const header = /^(?<type>graph|flowchart(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|classDiagram)\b\s*(?<dir>TB|TD|BT|RL|LR)?/i.exec(text);
      if (header) {
        type = header.groups!.type!.toLowerCase().replace(/-v2$/, '');
        direction = (header.groups!.dir ?? 'TB').toUpperCase();
        headerSeen = true;
        // A header line may carry a first statement after it on the same line.
        const rest = text.slice(header[0].length).trim();
        if (!rest) continue;
        parseStatement({ text: rest, pos: 0, line: stmt.line });
        continue;
      }
      // No recognisable header: treat the whole block as a bare flowchart.
      headerSeen = true;
    }

    if (IGNORED.test(text)) continue;

    const sub = /^subgraph\s+(?<rest>.+)$/i.exec(text);
    if (sub) {
      const { id, label } = parseSubgraphHeader(sub.groups!.rest!);
      const entry: MermaidSubgraph = { id, label, nodes: [] };
      subgraphs.push(entry);
      stack.push(entry);
      continue;
    }
    if (/^end$/i.test(text)) {
      stack.pop();
      continue;
    }

    parseStatement({ text, pos: 0, line: stmt.line });
  }

  /** Parse one `A --> B --> C` chain, including `&` fan-out. */
  function parseStatement(cur: Cursor): void {
    skipSpace(cur);
    if (cur.pos >= cur.text.length) return;

    let left = readNodeGroup(cur);
    if (!left) {
      throw new MermaidParseError(`expected a node, found ${JSON.stringify(remainder(cur))}`, cur.line);
    }

    // A lone `A[Label]` statement just declares a node.
    skipSpace(cur);
    if (cur.pos >= cur.text.length) return;

    while (cur.pos < cur.text.length) {
      const link = readLink(cur);
      if (!link) {
        throw new MermaidParseError(`expected a link, found ${JSON.stringify(remainder(cur))}`, cur.line);
      }

      skipSpace(cur);
      const right = readNodeGroup(cur);
      if (!right) {
        throw new MermaidParseError(`link ${JSON.stringify(link.raw)} has no target node`, cur.line);
      }

      for (const from of left) {
        for (const to of right) {
          edges.push({
            from,
            to,
            label: link.label,
            style: link.style,
            directed: link.directed,
            raw: link.raw,
          });
        }
      }

      left = right;
      skipSpace(cur);
    }
  }

  /** `A` or `A & B` -- returns the ids, registering any inline declarations. */
  function readNodeGroup(cur: Cursor): string[] | null {
    const ids: string[] = [];
    for (;;) {
      skipSpace(cur);
      const id = readNode(cur);
      if (!id) return ids.length ? ids : null;
      ids.push(id);
      skipSpace(cur);
      if (cur.text[cur.pos] === '&') {
        cur.pos++;
        continue;
      }
      return ids;
    }
  }

  /** Read `id` plus an optional shape, and record the node. */
  function readNode(cur: Cursor): string | null {
    const idMatch = NODE_ID.exec(cur.text.slice(cur.pos));
    if (!idMatch) return null;

    const id = (idMatch.groups!.quoted ?? idMatch.groups!.bare!).trim();
    cur.pos += idMatch[0].length;

    let label: string | null = null;
    let shape: MermaidShape = 'rect';
    const rest = cur.text.slice(cur.pos);

    for (const [re, name] of SHAPES) {
      const m = re.exec(rest);
      if (m) {
        label = stripQuotes(m.groups!.label ?? '').trim();
        shape = name;
        cur.pos += m[0].length;
        break;
      }
    }

    const existing = nodes.get(id);
    if (existing) {
      // A later declaration with a real label wins over a bare mention.
      if (label !== null) {
        existing.label = label;
        existing.shape = shape;
      }
    } else {
      nodes.set(id, {
        id,
        label: label ?? id,
        shape,
        subgraph: stack.length ? stack[stack.length - 1]!.id : null,
      });
    }

    const owner = stack[stack.length - 1];
    if (owner && !owner.nodes.includes(id)) owner.nodes.push(id);

    return id;
  }

  function readLink(cur: Cursor):
    | { raw: string; label: string | null; style: EdgeStyle; directed: boolean }
    | null {
    skipSpace(cur);
    const rest = cur.text.slice(cur.pos);

    // Greedy first: a complete link beats a labelled one, matching Mermaid's
    // lexer. This is what keeps `A --- B --- C` from reading B as a label.
    const full = FULL_LINK.exec(rest);
    if (full) {
      const raw = full[0];
      cur.pos += raw.length;

      let label: string | null = null;
      const pipe = PIPE_LABEL.exec(cur.text.slice(cur.pos));
      if (pipe) {
        label = stripQuotes(pipe.groups!.label ?? '').trim() || null;
        cur.pos += pipe[0].length;
      }

      return { raw, label, style: styleOf(raw), directed: directedOf(raw, full.groups!.lhead) };
    }

    const open = OPEN_LINK.exec(rest);
    if (!open) return null;

    // `-- text -->`: scan forward for the closing half.
    const after = cur.pos + open[0].length;
    for (let i = after; i <= cur.text.length; i++) {
      const close = CLOSE_LINK.exec(cur.text.slice(i));
      if (!close) continue;

      const label = stripQuotes(cur.text.slice(after, i)).trim();
      const raw = cur.text.slice(cur.pos, i + close[0].length);
      cur.pos = i + close[0].length;
      return {
        raw,
        label: label || null,
        style: styleOf(raw),
        directed: directedOf(raw, open.groups!.lhead),
      };
    }
    return null;
  }

  const graph: MermaidGraph = {
    type,
    direction,
    nodes: [...nodes.values()],
    edges,
    subgraphs,
    raw: source,
    node: (id) => nodes.get(id),
    from: (id) => edges.filter((e) => e.from === id),
    to: (id) => edges.filter((e) => e.to === id),
    hasEdge: (a, b) => edges.some((e) => e.from === a && e.to === b),
    hasPath(a, b) {
      const seen = new Set<string>();
      const queue = [a];
      while (queue.length) {
        const cur = queue.shift()!;
        if (cur === b && cur !== a) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const e of edges) {
          if (e.from === cur) queue.push(e.to);
          else if (!e.directed && e.to === cur) queue.push(e.from);
        }
      }
      return false;
    },
    roots: () => [...nodes.values()].filter((n) => !edges.some((e) => e.to === n.id)),
    leaves: () => [...nodes.values()].filter((n) => !edges.some((e) => e.from === n.id)),
  };

  return graph;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function splitStatements(source: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const lines = source.split('\n');

  lines.forEach((raw, i) => {
    const withoutComment = raw.replace(/%%.*$/, '');
    for (const part of withoutComment.split(';')) {
      const text = part.trim();
      if (text) out.push({ text, line: i + 1 });
    }
  });

  return out;
}

function parseSubgraphHeader(rest: string): { id: string; label: string } {
  // `subgraph id[Label]`, `subgraph id [Label]`, or `subgraph Just A Label`
  const m = /^(?<id>[A-Za-z0-9_][A-Za-z0-9_.-]*)\s*(?:\[(?<label>[\s\S]*?)\]|\((?<round>[\s\S]*?)\))?$/.exec(rest.trim());
  if (m) {
    const id = m.groups!.id!;
    const label = m.groups!.label ?? m.groups!.round;
    return { id, label: stripQuotes(label ?? id).trim() };
  }
  const label = stripQuotes(rest.trim());
  return { id: label, label };
}

function styleOf(raw: string): EdgeStyle {
  if (raw.includes('~')) return 'invisible';
  if (raw.includes('=')) return 'thick';
  if (raw.includes('.')) return 'dotted';
  return 'normal';
}

function directedOf(raw: string, leftHead: string | undefined): boolean {
  return Boolean(leftHead) || /[>ox]$/.test(raw);
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function skipSpace(cur: Cursor): void {
  while (cur.pos < cur.text.length && /\s/.test(cur.text[cur.pos]!)) cur.pos++;
}

function remainder(cur: Cursor): string {
  return cur.text.slice(cur.pos, cur.pos + 24);
}
