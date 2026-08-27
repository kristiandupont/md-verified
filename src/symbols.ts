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

import ts from 'typescript';

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
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/**
 * The string-literal members of a union type, in declaration order.
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
 * Reads the declaration only -- there is no type checker here, so a union built
 * by reference (`keyof typeof X`, or an alias of another alias) is refused
 * rather than guessed at.
 */
export function typeMembers(module: string | URL, name: string): string[] {
  const { path, node } = declaration(module, name);

  if (ts.isEnumDeclaration(node)) {
    return node.members.map((m) => (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)
      ? m.name.text
      : m.name.getText()));
  }

  if (!ts.isTypeAliasDeclaration(node)) {
    throw new Error(
      `${name} in ${path} is ${kindName(node)}, not a type alias; ` +
        `use propertiesOf() for an interface or object type`,
    );
  }

  const parts = ts.isUnionTypeNode(node.type) ? [...node.type.types] : [node.type];
  const members: string[] = [];

  for (const part of parts) {
    if (ts.isLiteralTypeNode(part) && ts.isStringLiteral(part.literal)) {
      members.push(part.literal.text);
      continue;
    }
    throw new Error(
      `${name} in ${path} is not a union of string literals ` +
        `(\`${part.getText()}\` is not one), so its members cannot be read from the declaration`,
    );
  }

  return members;
}

/**
 * The property and method names an interface or object type declares.
 *
 * ```ts
 * propertiesOf(new URL('../src/orchestrator.ts', import.meta.url), 'ActionEffects');
 * // ['commit', 'revert']
 * ```
 *
 * Throws, for the same reason `typeMembers` does. Inherited members are not
 * included: `extends` is a reference this cannot follow without a type checker,
 * and silently returning only half an interface would be worse than refusing.
 */
export function propertiesOf(module: string | URL, name: string): string[] {
  const { path, node } = declaration(module, name);

  const members = ts.isInterfaceDeclaration(node)
    ? node.members
    : ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)
      ? node.type.members
      : ts.isClassDeclaration(node)
        ? node.members
        : null;

  if (!members) {
    throw new Error(
      `${name} in ${path} is ${kindName(node)}, which declares no properties; ` +
        `use typeMembers() for a string-literal union`,
    );
  }

  if (ts.isInterfaceDeclaration(node) && node.heritageClauses?.length) {
    throw new Error(
      `${name} in ${path} extends another type, whose members cannot be read from ` +
        `this declaration alone; list the base type separately`,
    );
  }

  return members
    .map((m) => m.name)
    .filter((n): n is ts.PropertyName => n !== undefined)
    .map((n) => (ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : n.getText()));
}

/**
 * The declaration node for an exported name, or a thrown explanation.
 *
 * A `URL` resolves against itself, so glue passes
 * `new URL('../src/x.ts', import.meta.url)` and gets the same answer wherever
 * the command was run from. A bare string resolves against the process working
 * directory, which is what a one-off script wants and what a glue file
 * generally does not.
 */
function declaration(module: string | URL, name: string): { path: string; node: ts.Node } {
  const path =
    module instanceof URL || String(module).startsWith('file://')
      ? fileURLToPath(module)
      : ts.sys.resolvePath(String(module));

  const shown = module instanceof URL ? path : String(module);

  const symbols = exportedSymbols(path);
  if (symbols instanceof Error) {
    throw new Error(`${shown} could not be read: ${symbols.message}`);
  }
  if (!symbols.has(name)) {
    const known = [...symbols.keys()].sort().join(', ');
    throw new Error(`${shown} exports no \`${name}\`${known ? ` (it exports ${known})` : ''}`);
  }

  const node = nodeCache.get(path)?.get(name);
  if (!node) throw new Error(`${shown} exports \`${name}\`, but its declaration could not be read`);
  return { path: shown, node };
}

function kindName(node: ts.Node): string {
  if (ts.isInterfaceDeclaration(node)) return 'an interface';
  if (ts.isTypeAliasDeclaration(node)) return 'a type alias';
  if (ts.isClassDeclaration(node)) return 'a class';
  if (ts.isEnumDeclaration(node)) return 'an enum';
  if (ts.isFunctionDeclaration(node)) return 'a function';
  return 'a declaration';
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
