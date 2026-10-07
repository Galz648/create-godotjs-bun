// Read-only checks: they inspect the AST and checker and only answer a question or throw a build error.
// They never produce edits. transform.ts decides what to do with the answers.
import ts from "typescript";
import { importedEngineClass } from "./engine-classes.ts";
import { declaredByEngine, fail, hasModifier, isCallableInstance, resolveAlias } from "./ts-utils.ts";

function isDefaultExported(node: ts.ClassLikeDeclaration): boolean {
  if (!ts.isClassDeclaration(node)) return false;
  if (hasModifier(node, ts.SyntaxKind.ExportKeyword) && hasModifier(node, ts.SyntaxKind.DefaultKeyword)) return true;
  const name = node.name?.text;
  if (!name) return false;
  for (const stmt of node.getSourceFile().statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals && ts.isIdentifier(stmt.expression) && stmt.expression.text === name) {
      return true;
    }
    if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        if (el.name.text === "default" && (el.propertyName?.text ?? el.name.text) === name) return true;
      }
    }
  }
  return false;
}

// True when the class (or an ancestor in the project) extends a class declared in a .d.ts, which is how
// the engine's classes arrive.
function extendsGodotClass(node: ts.ClassLikeDeclaration, checker: ts.TypeChecker): boolean {
  const seen = new Set<ts.Node>();
  const visit = (cls: ts.ClassLikeDeclaration): boolean => {
    if (seen.has(cls)) return false;
    seen.add(cls);
    for (const clause of cls.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const heritage of clause.types) {
        const raw = checker.getSymbolAtLocation(heritage.expression) ?? checker.getTypeAtLocation(heritage).getSymbol();
        if (!raw) continue;
        // A base imported from "godot" is an engine class even when the stand-in typings do not declare it (Area2D, CanvasLayer, ...).
        if (importedEngineClass(heritage.expression, checker)) return true;
        const base = resolveAlias(raw, checker);
        for (const decl of base.declarations ?? []) {
          if (decl.getSourceFile().isDeclarationFile) return true;
          if (ts.isClassLike(decl) && visit(decl)) return true;
        }
      }
    }
    return false;
  };
  return visit(node);
}

export function isScriptClass(node: ts.ClassLikeDeclaration, checker: ts.TypeChecker): boolean {
  return isDefaultExported(node) && extendsGodotClass(node, checker);
}

export function scriptClassProblem(node: ts.ClassLikeDeclaration, checker: ts.TypeChecker): string {
  const problems: string[] = [];
  if (!isDefaultExported(node)) problems.push("which is not the default export of its file");
  if (!extendsGodotClass(node, checker)) problems.push("which does not extend a Godot class");
  return problems.join(" and ");
}

// True when the called method is declared by the engine's typings (Object.connect, Signal.connect, ...),
// so a user class with its own `connect` is not judged.
export function isEngineMethod(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const symbol = checker.getSymbolAtLocation(call.expression.name);
  return (symbol?.declarations ?? []).some((d) => d.getSourceFile().isDeclarationFile);
}

export function rejectNonCallable(arg: ts.Expression, call: ts.CallExpression, checker: ts.TypeChecker): void {
  const type = checker.getTypeAtLocation(arg);
  if (isCallableInstance(type)) return;
  if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never | ts.TypeFlags.Unknown | ts.TypeFlags.Void)) return;
  if (type.isUnion() && type.types.some((part) => part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))) return;
  const method = (call.expression as ts.PropertyAccessExpression).name.text;
  const what =
    type.getConstructSignatures().length > 0
      ? `the class \`${arg.getText()}\``
      : `\`${arg.getText()}\` (type ${checker.typeToString(type)})`;
  fail(
    arg,
    `${method}() takes a function or a Callable, not ${what}. ` +
      "Pass an arrow function, a function, or Callable.create(...); to connect a method write `(...args) => this.method(...args)`.",
  );
}

// True when a plain function or method passed as a callback uses `this` (an arrow is not judged).
export function thisUsingFunction(arg: ts.Expression, checker: ts.TypeChecker): boolean {
  if (ts.isArrowFunction(arg)) return false;
  let fn: ts.Node | undefined;
  if (ts.isFunctionExpression(arg)) fn = arg;
  else if (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) {
    const decl = checker.getSymbolAtLocation(ts.isIdentifier(arg) ? arg : arg.name)?.valueDeclaration;
    if (decl && (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl))) {
      fn = decl;
    }
    // A method reached through `this.` or another instance. A variable or arrow property is not judged.
  }
  if (!fn || !ts.isFunctionLike(fn) || !("body" in fn) || !fn.body) return false;
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      found = true;
      return;
    }
    // A nested function or class has its own `this`. An arrow shares this one.
    if (ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isClassLike(node) || ts.isMethodDeclaration(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(fn.body as ts.Node);
  return found;
}

// `this.label` read in a field initializer or the constructor, where an @onready field is still unset.
export function earlyOnreadyReads(node: ts.ClassLikeDeclaration, names: string[]): ts.PropertyAccessExpression[] {
  const reads: ts.PropertyAccessExpression[] = [];
  const set = new Set(names);
  const visit = (n: ts.Node) => {
    // Code that runs later (a function, an arrow, a method) is fine.
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword && set.has(n.name.text)) {
      const parent = n.parent;
      const isWrite =
        ts.isBinaryExpression(parent) && parent.left === n && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if (!isWrite) reads.push(n);
    }
    ts.forEachChild(n, visit);
  };
  for (const member of node.members) {
    if (ts.isPropertyDeclaration(member) && !hasModifier(member, ts.SyntaxKind.StaticKeyword) && member.initializer) {
      visit(member.initializer);
    } else if (ts.isConstructorDeclaration(member) && member.body) {
      member.body.statements.forEach(visit);
    }
  }
  return reads;
}

export function isSignalExpression(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  const symbol = checker.getTypeAtLocation(expr).getSymbol();
  return symbol?.getName() === "Signal" && declaredByEngine(symbol);
}
