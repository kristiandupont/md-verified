/** Public entry point. */
export { verify, assert, getRegistrations, registrations } from './framework.ts';
export type {
  VerifyContext,
  RowHandler,
  TableHandler,
  GraphHandler,
  EdgeHandler,
  ItemHandler,
  ListHandler,
} from './framework.ts';

export { parseMarkdown, parseSchema, parseCovers, findGlueHint, LABEL_KINDS } from './parser.ts';
export { covers } from './covers.ts';
export { checkReviews, digestOf } from './reviews.ts';
export type { ReviewOptions } from './reviews.ts';
export { exportedNames, exportedSymbol, exportedSymbols, clearSymbolCache } from './symbols.ts';
export type { SymbolInfo } from './symbols.ts';
export type { CoversOptions } from './covers.ts';
export {
  checkReferences,
  collectReferences,
  headingSlugs,
  slugify,
  clearReferenceCache,
} from './references.ts';
export type { Reference, ReferenceOptions } from './references.ts';
export { parseMermaid, MermaidParseError } from './mermaid.ts';
export { coerce, registerType, knownTypes, hasType, CoercionError } from './coerce.ts';
export { runFile, runParsed, runAnchor, planCases, resolveGlue, loadGlue } from './runner.ts';
export type { RunOptions, Plan, PlannedCase } from './runner.ts';
export { rewriteMarkdown, rewriteFromRun, formatRun, setColor, c } from './report.ts';
export * from './types.ts';
