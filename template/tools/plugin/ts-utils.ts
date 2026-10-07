// Small checker/AST helpers shared by transform.ts and diagnostics.ts.
import ts from "typescript";

export function loc(node: ts.Node): string {
  const sf = node.getSourceFile();
  const pos = sf.getLineAndCharacterOfPosition(node.getStart());
  return `${sf.fileName}:${pos.line + 1}:${pos.character + 1}`;
}

export function fail(node: ts.Node, message: string): never {
  throw new Error(`${loc(node)} ${message}`);
}

export function isAnyOrError(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Any) !== 0 || (type as { intrinsicName?: string }).intrinsicName === "error";
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

// `@gd.export.int()` -> { root: "gd", names: ["export", "int"] }
export function decoratorPath(decorator: ts.Decorator): { root: string; names: string[] } | null {
  let expr: ts.Expression = decorator.expression;
  if (ts.isCallExpression(expr)) expr = expr.expression;
  const names: string[] = [];
  while (ts.isPropertyAccessExpression(expr)) {
    names.unshift(expr.name.text);
    expr = expr.expression;
  }
  if (!ts.isIdentifier(expr)) return null;
  return { root: expr.text, names };
}

export function declaredByEngine(symbol: ts.Symbol | undefined): boolean {
  return (symbol?.declarations ?? []).some((d) => d.getSourceFile().isDeclarationFile);
}

export function isCallableInstance(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some((part) => isCallableInstance(part));
  return type.getSymbol()?.getName() === "Callable";
}

export function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  if (symbol.flags & ts.SymbolFlags.Alias) return checker.getAliasedSymbol(symbol);
  return symbol;
}
