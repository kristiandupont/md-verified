/**
 * Static symbol lookup, via the TypeScript compiler API.
 *
 * Two features need to know what a module exports and what a given export's
 * source text is: link checking (`references.ts`) and review digests
 * (`reviews.ts`).
 *
 * This reads the file rather than importing it. That matters for three
 * reasons: importing a module runs it, which a lint has no business doing;
 * type-only exports do not exist at runtime and so cannot be seen by an
 * import; and a file that fails to load can still be read.
 *
 * The trade-off is that `export * from './x'` is not followed -- re-exported
 * names are invisible here in a way they would not be to an import.
 */
import { fileURLToPath } from 'node:url';

import ts from 'md-verified-typescript';

import { checkedPropertiesOf, checkedTypeMembers, clearCheckerCache } from './checker.ts';

export interface SymbolInfo {
  name: string;
  /** Declaration source, excluding leading comments. */
  text: string;
  /** 1-based line of the declaration. */
  line: number;
  kind: string;
}

/** Declaration nodes, kept beside the text so structure can be read as well. */
const nodeCache = new Map<string, Map<string, ts.Node>>();

const fileCache = new Map<string, Map<string, SymbolInfo> | Error>();

/** Every exported symbol in a file, keyed by name. */
export function exportedSymbols(path: string): Map<string, SymbolInfo> | Error {
  const cached = fileCache.get(path);
  if (cached !== undefined) return cached;

  let result: Map<string, SymbolInfo> | Error;
  try {
    result = read(path);
  } catch (err) {
    result = err instanceof Error ? err : new Error(String(err));
  }
  fileCache.set(path, result);
  return result;
}

/** Names only. */
export function exportedNames(path: string): Set<string> | Error {
  const symbols = exportedSymbols(path);
  return symbols instanceof Error ? symbols : new Set(symbols.keys());
}

/** One exported symbol's declaration, or `undefined` if there is no such export. */
export function exportedSymbol(path: string, name: string): SymbolInfo | Error | undefined {
  const symbols = exportedSymbols(path);
  return symbols instanceof Error ? symbols : symbols.get(name);
}

export function clearSymbolCache(): void {
  fileCache.clear();
  nodeCache.clear();
  clearCheckerCache();
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/**
 * The string-literal members of a union type.
 *
 * ```ts
 * // export type OutcomeKind = 'success' | 'note-error';
 * const classify = new URL('../src/classify.ts', import.meta.url);
 * typeMembers(classify, 'OutcomeKind'); // ['success', 'note-error']
 * ```
 *
 * "This table's rows are exactly the members of this type" is the archetypal
 * claim in a typed codebase, and the one that rots silently. Without this,
 * every such document needs its own source-text parser in glue, and each one is
 * subtly wrong in its own way.
 *
 * Unlike `exportedSymbol`, this **throws** rather than returning an `Error`:
 * it is called from glue, where throwing is how a case fails. The message says
 * which of the several possible reasons applied, because a member list that is
 * silently empty is worse than no member list at all.
 *
 * A union written out as literals, and an enum, are read from the declaration,
 * in declaration order. Anything else -- `(typeof X)[keyof typeof X]`,
 * `(typeof ARR)[number]`, `Exclude<...>`, mapped and conditional types, a
 * re-export -- is resolved by the type checker and returned sorted. A result
 * that is not a finite set of string literals is refused.
 */
export function typeMembers(module: string | URL, name: string): string[] {
  const { path, shown, node } = declaration(module, name);

  if (node && ts.isEnumDeclaration(node)) {
    return node.members.map((m) => (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)
      ? m.name.text
      : m.name.getText()));
  }

  if (node && ts.isTypeAliasDeclaration(node) && !node.typeParameters) {
    const parts = ts.isUnionTypeNode(node.type) ? [...node.type.types] : [node.type];
    const literal = (part: ts.TypeNode) => ts.isLiteralTypeNode(part) && ts.isStringLiteral(part.literal);
    if (parts.every(literal)) {
      return parts.map((part) => ((part as ts.LiteralTypeNode).literal as ts.StringLiteral).text);
    }
  }

  return checkedTypeMembers(path, shown, name);
}

/**
 * The property and method names an interface or object type declares.
 *
 * ```ts
 * propertiesOf(new URL('../src/orchestrator.ts', import.meta.url), 'ActionEffects');
 * // ['commit', 'revert']
 * ```
 *
 * Throws, for the same reason `typeMembers` does. An interface without
 * `extends`, an object type literal and a class are read from the declaration,
 * in declaration order. Anything else -- inherited members, intersections,
 * mapped types, a re-export -- is resolved by the type checker and returned
 * sorted. A type with an index signature is refused, since its property names
 * are not a finite set.
 */
export function propertiesOf(module: string | URL, name: string): string[] {
  const { path, shown, node } = declaration(module, name);

  const members = !node
    ? null
    : ts.isInterfaceDeclaration(node) && !node.heritageClauses?.length && !node.typeParameters
      ? node.members
      : ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type) && !node.typeParameters
        ? node.type.members
        : ts.isClassDeclaration(node)
          ? node.members
          : null;

  if (!members) return checkedPropertiesOf(path, shown, name);

  return members
    .map((m) => m.name)
    .filter((n): n is ts.PropertyName => n !== undefined)
    .map((n) => (ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : n.getText()));
}

/**
 * Where `module` is, and the declaration of `name` in it when the file
 * declares that export itself. `node` is absent for a name the file does not
 * declare, which may still be a re-export; the checker decides.
 *
 * A `URL` resolves against itself, so glue passes
 * `new URL('../src/x.ts', import.meta.url)` and gets the same answer wherever
 * the command was run from. A bare string resolves against the process working
 * directory, which is what a one-off script wants and what a glue file
 * generally does not.
 */
function declaration(
  module: string | URL,
  name: string,
): { path: string; shown: string; node: ts.Node | undefined } {
  const path =
    module instanceof URL || String(module).startsWith('file://')
      ? fileURLToPath(module)
      : ts.sys.resolvePath(String(module));

  const shown = module instanceof URL ? path : String(module);

  const symbols = exportedSymbols(path);
  if (symbols instanceof Error) {
    throw new Error(`${shown} could not be read: ${symbols.message}`);
  }
  return { path, shown, node: nodeCache.get(path)?.get(name) };
}

// ---------------------------------------------------------------------------

function read(path: string): Map<string, SymbolInfo> {
  const text = ts.sys.readFile(path);
  if (text === undefined) throw new Error('could not read file');

  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found = new Map<string, SymbolInfo>();
  const nodes = new Map<string, ts.Node>();
  nodeCache.set(path, nodes);

  const add = (name: string, node: ts.Node, kind: string) => {
    if (found.has(name)) return;
    nodes.set(name, node);
    found.set(name, {
      name,
      text: node.getText(source),
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      kind,
    });
  };

  for (const statement of source.statements) {
    if (!isExported(statement)) {
      // `export { a, b }` carries no modifier of its own.
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          add(element.name.text, element, 'export');
        }
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          add(declaration.name.text, declaration, 'variable');
        }
      }
      continue;
    }

    if (isDefault(statement)) {
      add('default', statement, 'default');
      continue;
    }

    const name = (statement as any).name;
    if (name && ts.isIdentifier(name)) {
      add(name.text, statement, kindOf(statement));
    }
  }

  return found;
}

function isExported(node: ts.Statement): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function isDefault(node: ts.Statement): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword),
  );
}

function kindOf(node: ts.Statement): string {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  return 'declaration';
}
