# Writing documents that stay true

The goal is documents that are still true in a year. That is not the same as
documents that are fully verified, and chasing the second will cost you the
first.

Verification has a price: a handler to write, a handler to maintain, and a
failure that has to be understood before anyone can merge. Pay it where a
silent lie would hurt. Everywhere else, write prose — prose is what people
actually read, and it carries the things that matter most and verify least.

This page has no verified claims of its own. It makes no claims about code, so
there is nothing here to bind.

## Write the prose first

Explain the thing to a person. Say what it does, why it works that way, and
what you rejected. Then read back what you wrote and ask which sentences would
be *quietly* wrong if someone changed the code next month.

Those sentences are your candidates. Not the other way round: if you start from
the anchors, you will write prose that exists to justify the tables, and it
will read like it.

## What earns an anchor

One question decides it:

> If this claim silently became false, would anyone be hurt?

"Silently" is doing the work. A wrong sentence that everyone notices is a
typo. A wrong sentence that survives three releases because nothing contradicts
it is the thing this tool exists for.

Three shapes reliably pay for themselves:

**A closed set.** The payment methods. The legal state transitions. The tax
jurisdictions. Someone will add a fifth one and not think about your document.
`covers()` catches that, and nothing else does — every row-by-row check passes
happily while the set is incomplete. This is the highest-value anchor you can
write, and usually the cheapest.

**A rule with a canonical example.** Four rows that show how a total is
computed, including the one edge case people get wrong. You are checking the
*rule*, not sampling its input space.

**Structure you would have drawn anyway.** If the diagram is there for the
reader, verifying it costs one handler.

## What to leave alone

**Rationale.** *Why* shipping is not taxed. Why the previous approach failed.
This is the most valuable content in most documents and none of it is
executable. Leave it as prose and put a review on it.

**Anything the types already prove.** If the compiler rejects the wrong thing,
a table asserting it is theatre.

**Anything where the test would restate the implementation.** If your handler
is shaped like `assert(f(x) === f(x))`, you have written a tautology with extra
steps. Delete it. A test that cannot fail is worse than no test, because it
looks like coverage.

**Illustrative examples.** One example that shows the shape teaches more than
thirty that cover the space. If you genuinely need thirty, you want a property
test in the test suite, not a document.

## Two tests before you add something

**For a diagram — the whiteboard test.** Would you sketch this when explaining
the system to a new colleague? If yes, draw it, and verify it while you are
there. If no, do not draw it. A diagram that restates the file listing helps
nobody, and verifying it converts a useless diagram into a useless diagram
plus a maintenance burden.

**For a table — the colleague test.** Would you have written this table anyway,
to explain the rule? If you are adding rows to satisfy the runner, stop. A
table in a document should be readable at a glance. If it needs scrolling, it
belongs in the test suite.

## Reviews, for everything else

Most of a good document cannot be executed. A review is the honest fallback: it
does not check that the prose is *right*, only that a human has read it since
the code behind it last changed.

```markdown
> 👁️ **Reviewed:** `settlement`
> **Covers:** `../src/checkout.ts#paymentMethod`
```

Run `--stamp` once you have read the two together. When `paymentMethod` next
changes, the section is flagged and someone has to look again.

Point `Covers:` at **symbols, not files**, wherever you can. A file-level target
is invalidated by every unrelated edit in that file, and a review that cries
wolf gets stamped without being read — at which point you have a ritual instead
of a check.

Put reviews on the paragraphs that would embarrass you if they went stale, not
on every heading. Three meaningful reviews beat twenty that everyone re-stamps
in a batch.

## Smells

- **The exhaustive table.** Forty rows walking an input space. Nobody reads it,
  and it does not fail more usefully than four rows would.
- **The decorative diagram.** A graph of the module structure. It was true once.
- **The tautology handler.** It reimplements the code it is checking, so it
  agrees with the code by construction.
- **The blind stamp.** `--stamp` run across the repository to turn the build
  green. Every review in the project now attests to nothing. If you are going
  to do this, delete the reviews instead — at least then the document is honest
  about what it does not know.
- **Anchors outnumbering paragraphs.** You are writing tests in Markdown. They
  will be worse than the tests in your test suite and harder to run.

## How much is enough

Most of a document should be unverified prose. If more than about a third of a
page is anchors, look again — usually two or three of them are carrying the
weight and the rest are there because they were easy.

A page should fit on a screen or two. When it does not, that is a signal about
the code as often as it is about the document.

The measure of success is not the number of green checks. It is that someone
reading the page in a year believes it, and is right to.
