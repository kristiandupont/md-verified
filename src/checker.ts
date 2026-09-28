/**
 * Type-checker-backed reading of declared types.
 *
 * `typeMembers()` and `propertiesOf()` read a declaration directly when it
 * lists its members. Most types in a typed codebase are built by reference
 * instead -- `(typeof X)[keyof typeof X]`, `Exclude<...>`, mapped and
 * conditional types, interfaces that `extend` -- and those need the checker.
 *
 * One program is created per tsconfig, with the compiler options found by
 * searching upward from the file being read, and cached for the run. Its root
 * files are only the files asked about; the rest of the project is loaded
 * only as far as their imports reach. Asking about another file recreates the
 * program with the previous one as `oldProgram`, so files already parsed are
 * reused.
 *
 * The same rule as the declaration reader applies: when the answer is not a
 * finite set of names, refuse with the reason. `covers()` against a short list
 * passes when it should not.
 */
import { dirname, relative } from 'node:path';

import ts from 'md-verified-typescript';

interface ProjectEntry {
  options: ts.CompilerOptions;
  roots: Set<string>;
  program: ts.Program | undefined;
}

/** Keyed by tsconfig path, or `''` for files outside any tsconfig. */
const projects = new Map<string, ProjectEntry>();

/** Used when no tsconfig.json is found above the file. */
const DEFAULT_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true,
  allowImportingTsExtensions: true,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
};

export function clearCheckerCache(): void {
  projects.clear();
}

/** A program that contains `path`, created or extended as needed. */
export function programFor(path: string): ts.Program {
  const configPath = ts.findConfigFile(dirname(path), ts.sys.fileExists) ?? '';

  let entry = projects.get(configPath);
  if (!entry) {
    entry = { options: optionsFrom(configPath), roots: new Set(), program: undefined };
    projects.set(configPath, entry);
  }

  if (!entry.program || !entry.roots.has(path)) {
    entry.roots.add(path);
    entry.program = ts.createProgram({
      rootNames: [...entry.roots],
      options: entry.options,
      oldProgram: entry.program,
    });
  }
  return entry.program;
}

function optionsFrom(configPath: string): ts.CompilerOptions {
  if (!configPath) return DEFAULT_OPTIONS;

  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, { noEmit: true }, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(
        `${configPath} could not be read: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
      );
    },
  });
  // Diagnostics such as "no inputs were found" do not affect the options, and
  // the options are all that is used here.
  return parsed?.options ?? DEFAULT_OPTIONS;
}

// ---------------------------------------------------------------------------

interface Resolved {
  checker: ts.TypeChecker;
  symbol: ts.Symbol;
}

/** The symbol a module exports as `name`, with re-exports followed. */
function exported(path: string, shown: string, name: string): Resolved {
  const program = programFor(path);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(path);
  if (!source) throw new Error(`${shown} could not be loaded by the type checker`);

  const module = checker.getSymbolAtLocation(source);
  const exports = module ? checker.getExportsOfModule(module) : [];
  const found = exports.find((s) => s.getName() === name);

  if (!found) {
    const known = exports.map((s) => s.getName()).sort().join(', ');
    throw new Error(`${shown} exports no \`${name}\`${known ? ` (it exports ${known})` : ''}`);
  }

  const symbol = found.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(found) : found;
  return { checker, symbol };
}

const isGeneric = (symbol: ts.Symbol): boolean =>
  (symbol.declarations ?? []).some(
    (d) =>
      (ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
      Boolean(d.typeParameters?.length),
  );

/** The failure for a type that resolved to `any`, which is almost always an unresolved import. */
const anyReason = (name: string, shown: string) =>
  `${name} in ${shown} resolves to \`any\`, so it has no members to read; ` +
  `usually an import in it could not be resolved with the nearest tsconfig.json`;

/** `typeMembers()` for a type the declaration alone does not answer. Sorted. */
export function checkedTypeMembers(path: string, shown: string, name: string): string[] {
  const { checker, symbol } = exported(path, shown, name);

  if (symbol.flags & ts.SymbolFlags.Enum) {
    // Member names in declaration order, as the declaration reader gives them.
    return [...(symbol.exports?.values() ?? [])]
      .filter((m) => m.flags & ts.SymbolFlags.EnumMember)
      .map((m) => m.getName());
  }

  if (!(symbol.flags & ts.SymbolFlags.TypeAlias)) {
    if (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) {
      throw new Error(
        `${name} in ${shown} is an interface or class, not a type alias; ` +
          `use propertiesOf() for an interface or object type`,
      );
    }
    throw new Error(
      `${name} in ${shown} is a value, not a type. For the values of a const object, ` +
        `export \`type ${name}Value = (typeof ${name})[keyof typeof ${name}]\` and read that`,
    );
  }
  if (isGeneric(symbol)) {
    throw new Error(`${name} in ${shown} is generic, so it has no members until it is instantiated`);
  }

  const type = checker.getDeclaredTypeOfSymbol(symbol);
  if (type.flags & ts.TypeFlags.Any) throw new Error(anyReason(name, shown));
  if (type.flags & ts.TypeFlags.Never) return [];

  const members: string[] = [];
  for (const part of type.isUnion() ? type.types : [type]) {
    if (!part.isStringLiteral()) {
      throw new Error(
        `${name} in ${shown} is not a union of string literals ` +
          `(it includes \`${checker.typeToString(part)}\`), so it is not a finite set of names`,
      );
    }
    members.push(part.value);
  }
  return [...new Set(members)].sort();
}

/** `propertiesOf()` for a type the declaration alone does not answer. Sorted. */
export function checkedPropertiesOf(path: string, shown: string, name: string): string[] {
  const { checker, symbol } = exported(path, shown, name);

  const typeFlags = ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface | ts.SymbolFlags.Class;
  if (!(symbol.flags & typeFlags)) {
    throw new Error(
      `${name} in ${shown} is ${symbol.flags & ts.SymbolFlags.Enum ? 'an enum' : 'a value'}, ` +
        `not an interface or object type`,
    );
  }
  if (isGeneric(symbol)) {
    throw new Error(`${name} in ${shown} is generic, so its properties depend on how it is instantiated`);
  }

  const type = checker.getDeclaredTypeOfSymbol(symbol);
  if (type.flags & ts.TypeFlags.Any) throw new Error(anyReason(name, shown));
  if (type.isUnion()) {
    throw new Error(
      `${name} in ${shown} is a union, whose members need not share properties; ` +
        `use typeMembers() for a string-literal union`,
    );
  }
  if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) {
    throw new Error(
      `${name} in ${shown} is \`${checker.typeToString(type)}\`, which declares no properties`,
    );
  }
  if (checker.getIndexInfosOfType(type).length > 0) {
    throw new Error(
      `${name} in ${shown} has an index signature, so its property names are not a finite set`,
    );
  }

  const names = checker.getPropertiesOfType(type).map((p) => p.getName());
  const symbolKeyed = names.find((n) => n.startsWith('__@'));
  if (symbolKeyed) {
    throw new Error(`${name} in ${shown} has a symbol-keyed property, which has no name to list`);
  }
  return names.sort();
}

// ---------------------------------------------------------------------------
// Typechecking glue
// ---------------------------------------------------------------------------

/** One type error, located in the file that was checked. */
export interface TypeProblem {
  /** The checked file, relative to the working directory. */
  file: string;
  line: number;
  column: number;
  /** `TS2322: ...`, on one line. */
  message: string;
}

/**
 * The type errors in one file, checked with the compiler options of the
 * nearest tsconfig.json above it.
 *
 * Only diagnostics located in `path` itself are returned. Errors in the
 * application code a glue file imports belong to the project's own `tsc` run,
 * and options diagnostics -- such as a glue file lying outside `rootDir` --
 * describe the project's layout rather than the glue.
 */
export function typecheckFile(path: string): TypeProblem[] {
  const program = programFor(path);
  const source = program.getSourceFile(path);
  if (!source) throw new Error(`${path} could not be loaded by the type checker`);

  const diagnostics = [
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source),
  ];

  return diagnostics.map((d) => {
    const at = d.start === undefined ? null : source.getLineAndCharacterOfPosition(d.start);
    return {
      file: relative(process.cwd(), path),
      line: at ? at.line + 1 : 1,
      column: at ? at.character + 1 : 1,
      message: `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
    };
  });
}
