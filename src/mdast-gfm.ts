/**
 * Minimal `mdast-util-from-markdown` extensions for GFM tables and task-list
 * items.
 *
 * These are normally provided by `mdast-util-gfm-table` /
 * `mdast-util-gfm-task-list-item`, but those packages also ship the
 * *serialisation* half, which pulls in `mdast-util-to-markdown` ->
 * `unist-util-visit-parents`. Bun 1.3.x cannot resolve that package's
 * self-referencing `./do-not-use-color` subpath export, so importing them
 * crashes at startup.
 *
 * We only ever *read* Markdown -- status rewriting is done as a surgical
 * string splice against the original source (see `report.ts`), never by
 * re-serialising the AST -- so the from-markdown handlers below are all we
 * need. They are ported from the upstream implementations, minus `devlop`
 * asserts.
 */
import type { Extension, CompileContext, Handle } from 'mdast-util-from-markdown';

/** Enable `table` / `tableRow` / `tableCell` nodes. */
export function gfmTableFromMarkdown(): Extension {
  return {
    enter: {
      table: enterTable,
      tableData: enterCell,
      tableHeader: enterCell,
      tableRow: enterRow,
    },
    exit: {
      codeText: exitCodeText,
      table: exitNode,
      tableData: exitNode,
      tableHeader: exitNode,
      tableRow: exitNode,
    },
  };
}

const enterTable: Handle = function (this: CompileContext, token) {
  const align = (token as any)._align as Array<string> | undefined;
  this.enter(
    {
      type: 'table',
      align: (align ?? []).map((d) => (d === 'none' ? null : d)) as any,
      children: [],
    } as any,
    token,
  );
  (this.data as any).inTable = true;
};

const exitTable: Handle = function (this: CompileContext, token) {
  this.exit(token);
  (this.data as any).inTable = undefined;
};

const enterRow: Handle = function (this: CompileContext, token) {
  this.enter({ type: 'tableRow', children: [] } as any, token);
};

const enterCell: Handle = function (this: CompileContext, token) {
  this.enter({ type: 'tableCell', children: [] } as any, token);
};

function exitNode(this: CompileContext, token: Parameters<Handle>[0]) {
  if (token.type === 'table') return exitTable.call(this, token as any);
  this.exit(token);
}

/** Inside a table, `\|` inside inline code means a literal pipe. */
const exitCodeText: Handle = function (this: CompileContext, token) {
  let value = this.resume();
  if ((this.data as any).inTable) {
    value = value.replace(/\\([\\|])/g, (whole, char) => (char === '|' ? char : whole));
  }
  const node: any = this.stack[this.stack.length - 1];
  node.value = value;
  this.exit(token);
};

/** Enable `listItem.checked` for `- [x]` / `- [ ]` items. */
export function gfmTaskListItemFromMarkdown(): Extension {
  return {
    exit: {
      taskListCheckValueChecked: exitCheck,
      taskListCheckValueUnchecked: exitCheck,
      paragraph: exitParagraphWithTaskListItem,
    },
  };
}

const exitCheck: Handle = function (this: CompileContext, token) {
  // Always inside a paragraph, inside a list item.
  const node: any = this.stack[this.stack.length - 2];
  node.checked = token.type === 'taskListCheckValueChecked';
};

/** Strip the space that followed the `[x]` marker from the item's text. */
const exitParagraphWithTaskListItem: Handle = function (this: CompileContext, token) {
  const parent: any = this.stack[this.stack.length - 2];

  if (parent && parent.type === 'listItem' && typeof parent.checked === 'boolean') {
    const node: any = this.stack[this.stack.length - 1];
    const head = node.children[0];

    if (head && head.type === 'text') {
      const firstParagraph = parent.children.find((c: any) => c.type === 'paragraph');

      if (firstParagraph === node) {
        head.value = head.value.slice(1);
        if (head.value.length === 0) {
          node.children.shift();
        } else if (node.position && head.position && typeof head.position.start.offset === 'number') {
          head.position.start.column++;
          head.position.start.offset++;
          node.position.start = { ...head.position.start };
        }
      }
    }
  }

  this.exit(token);
};
