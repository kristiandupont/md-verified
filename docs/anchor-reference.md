# Anchor reference

<!-- verify: ./anchor-reference.verify.ts -->

The vocabulary a document can use: which labels bind to which asset, which
types a `Schema:` line understands, and what each status glyph means.

Every table on this page is checked against the implementation, because each
one is a closed set that lives in exactly one place in the code and would
otherwise drift the first time someone added to it.

## How binding works

> ✅ **Reviewed:** `binding`
> **Covers:** `../src/parser.ts#parseMarkdown`
> **Digest:** `1:ab0e81b23ff8`

An anchor is a blockquote whose first line reads `**Verified <Label>:**`
followed by an id in backticks. The runner takes the **next block-level node**
and binds it — a table, a ` ```mermaid ` block, or a list.

Lookahead steps over comments the tool wrote itself, so a document already
annotated with failures still binds on the next run. It steps over nothing
else: a stray paragraph between an anchor and its asset is reported, not
searched past. That strictness is deliberate. A binding rule that scans forward
until it finds something plausible would silently attach an anchor to the wrong
table the day someone adds a sentence.

The label is a claim about what should follow. When the label and the actual
node disagree, that is an error rather than something to resolve in either
direction — the document is telling you two different things.

## Labels

Labels exist so a document can read naturally. `**Verified Flow:**` above a
diagram and `**Verified Rules:**` above a checklist say something to a human
that `**Verified Mermaid:**` does not.

> ✅ **Verified Data:** `labels`

| Label                                                | Binds to   |
| ---------------------------------------------------- | ---------- |
| `Data`, `Table`, `Rows`, `Examples`, `Cases`, `Dataset`, `Matrix` | `table`    |
| `Flow`, `Diagram`, `Graph`, `Mermaid`, `Flowchart`, `States`, `Sequence` | `mermaid`  |
| `Rules`, `List`, `Steps`, `Checklist`, `Items`       | `list`     |

## Schema types

A `Schema:` line names and types a table's columns positionally, so handlers
receive values rather than strings. The `Example` column below is coerced by
the test that checks this table, so these are guaranteed to be things the
parser actually accepts.

> ✅ **Verified Data:** `schemaTypes`
> **Schema:** `[type: String, aliases: String, example: String, becomes: String]`

| Type         | Aliases              | Example       | Becomes         |
| ------------ | -------------------- | ------------- | --------------- |
| `Currency`   | —                    | `$1,234.50`   | `1234.5`        |
| `Percentage` | —                    | `8.5%`        | `0.085`         |
| `Number`     | `Float`, `Decimal`   | `-3.5`        | `-3.5`          |
| `Integer`    | `Int`                | `42`          | `42`            |
| `Boolean`    | `Bool`               | `yes`         | `true`          |
| `Date`       | —                    | `2026-01-15`  | —               |
| `String`     | `Text`               | `hello`       | `"hello"`       |
| `JSON`       | —                    | `{"a": 1}`    | `{"a":1}`       |
| `List`       | —                    | `a, b, c`     | `["a","b","c"]` |

A trailing `?` on a field name (`discount?: Currency`) lets a blank cell
through as `null`. `verify.type()` adds your own.

## Status glyphs

The glyph on an anchor is written by the runner and read by everyone else. It
is the only part of a verified document that changes without a human touching
it.

> ✅ **Verified Data:** `glyphs`
> **Schema:** `[glyph: String, status: String, meaning: String]`

| Glyph | Status    | Means                                                    |
| ----- | --------- | -------------------------------------------------------- |
| 🛠️    | `pending` | Never run, or reset. The author's starting state.         |
| ✅    | `passed`  | Every case passed on the last run.                        |
| ❌    | `failed`  | At least one case failed. Details in the comment below.   |
| ⚠️    | `skipped` | Not run: filtered out by `--only`, or after `--bail`.      |

A review carries 👁️ until it is stamped, then ✅ or ❌ like anything else.

An anchor with no registered handler is `failed`, not `skipped`: a mistyped
id would otherwise remove the check and leave the run green.

## What this page does not check

The CLI's flags are a closed set too, and they are **not** verified here.
Extracting them would mean parsing an argument-parsing `switch`, which is
brittle in a way that would cost more than it returns — and a wrong flag list
is caught the moment anyone runs `--help`.

That trade is the normal case, not an exception. See
[writing documents that stay true](./writing.md) for how to make it.
