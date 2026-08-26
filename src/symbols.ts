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
import ts from 'typescript';

export interface SymbolInfo {
  name: string;
  /** Declaration source, excluding leading comments. */
  text: string;
  /** 1-based line of the declaration. */
  line: number;
  kind: string;
}

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
}

// ---------------------------------------------------------------------------

function read(path: string): Map<string, SymbolInfo> {
  const text = ts.sys.readFile(path);
  if (text === undefined) throw new Error('could not read file');

  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found = new Map<string, SymbolInfo>();

  const add = (name: string, node: ts.Node, kind: string) => {
    if (found.has(name)) return;
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
