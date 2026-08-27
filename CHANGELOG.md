# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the major version is `0`, a minor bump may contain breaking changes.

## [Unreleased]

### Changed

- **Breaking:** an anchor with no registered handler is now a **failure**, not a
  skip. It previously reported `⚠ skipped` and exited 0, so a mistyped anchor id
  or a deleted handler removed the check while CI stayed green. The message
  names the call to add: ``no handler registered for `x`; add
  verify.table('x', ...) to the glue file, or remove the anchor``.
- **Breaking:** `Plan.skipReason` and `DocumentSuite.skipReason` are removed.
  Nothing produces them now — an unbound anchor sets `failReason` instead, so a
  `bun test` bridge reports it as a failing test rather than a skipped one.
  `--only` and `--bail` skips are unaffected; they never went through `Plan`.
- `RewriteOptions.stamp` accepts `string[]` as well as `boolean`.

### Added

- `--stamp <id>` records a digest on one review, and is repeatable.
  `--stamp=<id>` is the unambiguous spelling. Bare `--stamp` still stamps every
  review in the document. Stamping all of them attests to sections nobody read,
  which defeated the point of per-section attestation.
- `--force`, to stamp despite failing anchors.
- `stamps()`, exported, deciding whether a run stamps a given review id.

- `--import <loader>` re-runs the command under `node --import <loader>`, so
  glue whose import graph uses extensionless relative specifiers resolves.
  Repeatable, and ignored under Bun, which needs no loader.

- `typeMembers(module, name)` returns the string-literal members of a union
  type, or an enum's member names, read off the declaration. `covers()` against
  it expresses "this table's rows are exactly the members of that type" without
  a hand-written source parser in glue. Both it and `propertiesOf()` accept a
  `URL`, so a path in glue resolves against the glue file rather than the
  working directory.
- `propertiesOf(module, name)` returns the property and method names an
  interface, object type alias or class declares.
- `assertionCount()` and `countAssertion()`, for counting assertions made by
  your own helpers.
- `CaseResult.assertions` and `RunSummary.casesUnasserted`, both also in
  `--json` output.

### Fixed

- A passing anchor whose handler asserted nothing is now reported as such:
  `✔ noop 2/2 (table, line 3) — 2 of 2 cases made no assertion`. Throwing is the
  whole contract, so a handler that checks nothing passes; that is the one case
  where a green anchor misleads its reader. It stays a note rather than a
  failure because a handler using a third-party assertion library is checking
  something this cannot see.
- `exportedNames()` and `exportedSymbol()` were exported from the entry point
  but documented nowhere, so glue that needed a symbol's declaration text
  reached for a regex over raw source instead. Both are now in the README.
- A glue file that fails to load with `ERR_MODULE_NOT_FOUND` on an extensionless
  specifier now says so, and names the fix. The bare Node message points at a
  module and a file the reader did not write the import in, so it read as a bug
  in the glue rather than a mismatch between the project's module resolution and
  Node's.
- The README's Runtimes section framed Node's limitation as type stripping
  alone, and prescribed `NODE_OPTIONS=--experimental-transform-types`. That flag
  changes how types are compiled and has no effect on module resolution, so it
  did not fix the failure most projects actually hit. Resolution and type
  stripping are now documented as the separate limits they are.
- `scripts/smoke.sh` imported application code with an explicit `.ts` extension,
  which no bundler-resolution project does — so the only test of the published
  shape never exercised the resolution failure. It now imports extensionlessly,
  and the node leg asserts both that the bare invocation explains itself and
  that `--import tsx` makes it work.
- `--stamp` no longer records an attestation on a run with failing anchors. The
  document and the code demonstrably disagree at that point, so a reading of the
  two together cannot have concluded they match. Use `--force` to override.
- `--stamp <id>` naming no review in the document is reported and exits 1,
  rather than silently stamping nothing.

## [0.1.1] - 2026-08-27

### Added

- `scripts/smoke.sh`: an end-to-end test that packs the package, installs it
  into a throwaway project and drives the CLI as a consumer would. Run in CI
  against both Node and Bun.

### Fixed

- Runtime compatibility under Node's type stripping: `CoercionError` no longer
  uses constructor parameter properties.
- `prepublishOnly` now builds, tests and smoke-tests before publishing.
- Markdown errors in the README.

## [0.1.0] - 2026-08-26

Initial release.

- Anchors binding a Markdown table, list or Mermaid diagram to glue code:
  `verify.table`, `verify.list`, `verify.mermaid`, each with an `all` or
  `edges` whole-asset form.
- `**Schema:**` lines coercing cell text to values, with built-in types for
  currency, percentages, numbers, booleans, dates, JSON and lists, and
  `verify.type()` for your own.
- `covers()`, asserting that a document describes every element that exists.
- Reviews: a digest of the code a prose section covers, recorded by `--stamp`
  and reported as stale when that code changes.
- Reference checking for links, image paths, `#heading` anchors and
  `./file.ts#exportName` symbol fragments.
- `--write`, recording each failure as an HTML comment above the asset that
  failed, and `--reset` to undo it.
- `--json` output, `--only`, `--bail`, `--timeout` and `--covering`.

[Unreleased]: https://github.com/kristiandupont/md-verified/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/kristiandupont/md-verified/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kristiandupont/md-verified/releases/tag/v0.1.0
