// Build-time diagnostics for SILENT bugs of builtin value types (engine tickets 262, 265, 267, 268). Pure validation like
// abort-checks.ts (ADR 0009: a validation is free, a rewrite is budgeted): nothing is rewritten.
//   lostWrite        (265, warning)  `node.rotation.y = x`: the write goes to a temporary copy and is lost.
//   badConversion    (262, ERROR)    `new Quaternion(basis)` and two more: the engine returns garbage with no error.
//   stringProblems   (267, warning)  a Vector3 in a template literal / String() / '' + v / JSON.stringify: `[object Object]`, `{}`.
//   packedProblems   (268, warning)  for...of / spread / Array.from of a Packed*Array: not iterable, Array.from gives [].
// Each fires only when the type is KNOWN: from the checker (stand-in typings), from the name of a class imported from "godot",
// from an annotation or a const, or from the member table (engine-members.ts). Any / unresolved / a user class of the same name /
// a member the user class declares itself stays silent ("silent rather than wrong").
import ts from "typescript";
import { engineClassRef, engineTypeName, nameFor, strip, typeRefName } from "./abort-checks.ts";
import { engineMethod, engineProperty, PACKED_TYPES, STRINGLESS_TYPES, VALUE_TYPES } from "./engine-members.ts";
import { importedEngineClass } from "./engine-classes.ts";
import { declaredByEngine } from "./ts-utils.ts";

export interface ValueProblem {
  node: ts.Node;
  ticket: string;
  message: string;
}

function userDeclared(symbol: ts.Symbol | undefined): boolean {
  return (symbol?.declarations ?? []).some((d) => !d.getSourceFile().isDeclarationFile);
}

/** The type a user declaration spells (`x: Vector3`, or `x = new Vector3()`), when it names an engine class. */
function declaredTypeName(symbol: ts.Symbol | undefined, checker: ts.TypeChecker, depth: number): string | null {
  const decl = symbol?.valueDeclaration;
  if (!decl) return null;
  if (
    ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl) || ts.isParameter(decl) || ts.isVariableDeclaration(decl) ||
    ts.isGetAccessorDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isFunctionDeclaration(decl)
  ) {
    if (decl.type) return typeRefName(decl.type, checker);
    if ((ts.isPropertyDeclaration(decl) || ts.isVariableDeclaration(decl)) && decl.initializer) return typeOf(decl.initializer, checker, depth + 1);
  }
  return null;
}

/** The engine class an expression names when used as a value (`OS`, `G.OS`): for static methods and singletons. */
function classRef(expr: ts.Expression, checker: ts.TypeChecker): string | null {
  return engineClassRef(expr, checker);
}

/** The engine type (class, value type, Packed array) of an expression, or null when it cannot be told. */
export function typeOf(expr: ts.Expression, checker: ts.TypeChecker, depth = 0): string | null {
  expr = strip(expr);
  if (depth > 6) return null;
  // The class itself (`Vector3`, `G.Vector3`) is not an instance of it.
  if (ts.isIdentifier(expr) && importedEngineClass(expr, checker)) return null;
  if (ts.isPropertyAccessExpression(expr) && !/^[A-Z][A-Z0-9_]*$/.test(expr.name.text) && classRef(expr, checker)) return null;
  const known = engineTypeName(expr, checker);
  if (known) return known;
  if (ts.isIdentifier(expr)) {
    // `const xf = node.transform;`: the const's initializer, read with this resolver (engineTypeName only knows `new`, `as`, constants).
    const decl = checker.getSymbolAtLocation(expr)?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && !decl.type && decl.initializer && ts.isVariableDeclarationList(decl.parent) && (decl.parent.flags & ts.NodeFlags.Const) !== 0) {
      return typeOf(decl.initializer, checker, depth + 1);
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const symbol = checker.getSymbolAtLocation(expr.name);
    if (userDeclared(symbol)) return declaredTypeName(symbol, checker, depth);
    const owner = receiverClass(expr.expression, checker, depth + 1);
    return owner ? engineProperty(owner, expr.name.text) : null;
  }
  if (ts.isCallExpression(expr)) {
    const callee = strip(expr.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const symbol = checker.getSymbolAtLocation(callee.name);
      if (userDeclared(symbol)) return declaredTypeName(symbol, checker, depth);
      const owner = receiverClass(callee.expression, checker, depth + 1);
      return owner ? engineMethod(owner, callee.name.text) : null;
    }
    if (ts.isIdentifier(callee)) {
      const decl = checker.getSymbolAtLocation(callee)?.valueDeclaration;
      if (decl && ts.isFunctionDeclaration(decl) && decl.type) return typeRefName(decl.type, checker);
    }
  }
  return null;
}

function receiverClass(expr: ts.Expression, checker: ts.TypeChecker, depth: number): string | null {
  expr = strip(expr);
  return typeOf(expr, checker, depth) ?? classRef(expr, checker);
}

// -- 265: a write to a member of a value type that an engine getter returned ----------------------------------------

/** The value type of `inner` when it is a property read or call that the ENGINE answers with a fresh copy, else null. */
function engineCopyType(inner: ts.Expression, checker: ts.TypeChecker): string | null {
  inner = strip(inner);
  let nameNode: ts.Identifier | undefined;
  let owner: ts.Expression | undefined;
  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name)) {
    nameNode = inner.name;
    owner = inner.expression;
  } else if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(strip(inner.expression))) {
    const callee = strip(inner.expression) as ts.PropertyAccessExpression;
    nameNode = callee.name as ts.Identifier;
    owner = callee.expression;
  } else return null;
  const symbol = checker.getSymbolAtLocation(nameNode);
  if (userDeclared(symbol)) return null; // a field of the user's own class holds a JS-side wrapper: writing through it is fine
  // Declared by the stand-in typings: the checker knows the type.
  if (declaredByEngine(symbol)) {
    const typeSymbol = checker.getTypeAtLocation(inner).getSymbol();
    if (typeSymbol && VALUE_TYPES.has(typeSymbol.getName()) && declaredByEngine(typeSymbol)) return typeSymbol.getName();
  }
  const cls = receiverClass(owner, checker, 1);
  if (!cls) return null;
  const type = ts.isCallExpression(inner) ? engineMethod(cls, nameNode.text) : engineProperty(cls, nameNode.text);
  return type && VALUE_TYPES.has(type) ? type : null;
}

/** `a.b.c = x`, `a.b.c += x`, `a.b.c++`, ... where `a.b` is a value type the engine copies out. */
export function lostWrite(node: ts.Node, checker: ts.TypeChecker): ValueProblem | null {
  let target: ts.Expression | undefined;
  if (ts.isBinaryExpression(node)) {
    const k = node.operatorToken.kind;
    if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) target = node.left;
  } else if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    target = node.operand;
  }
  if (!target) return null;
  target = strip(target);
  if (!ts.isPropertyAccessExpression(target)) return null;
  const inner = strip(target.expression);
  const typeName = engineCopyType(inner, checker);
  if (!typeName) return null;
  const isCall = ts.isCallExpression(inner);
  const read = inner.getText();
  const safe = isCall
    ? `Read it into a local, change that and assign it back through the property or its setter.`
    : `Assign the whole value (\`${read} = new ${typeName}(...)\`) or read it into a local, change the local and assign it back (\`const v = ${read}; v.${target.name.text} = ...; ${read} = v;\`).`;
  return {
    node: target,
    ticket: "265",
    message:
      `\`${target.getText()}\` changes a temporary copy: reading \`${read}\` from the engine returns a new ${typeName}, so this assignment is lost. ${safe}`,
  };
}

// -- 262: conversion constructors that return garbage ---------------------------------------------------------------

// The one-argument constructors that read the argument as the wrong type (copy-constructor overload picked): zeros or garbage, no error.
// (The ones that abort are abort-checks.ts, ticket 80.)
const BAD_CONVERSIONS: Record<string, { arg: string; safe: (v: string) => string }> = {
  Quaternion: { arg: "Basis", safe: (v) => `${v}.get_rotation_quaternion()` },
  Projection: {
    arg: "Transform3D",
    safe: (v) =>
      `new Projection(new Vector4(${v}.basis.x.x, ${v}.basis.x.y, ${v}.basis.x.z, 0), new Vector4(${v}.basis.y.x, ${v}.basis.y.y, ${v}.basis.y.z, 0), ` +
      `new Vector4(${v}.basis.z.x, ${v}.basis.z.y, ${v}.basis.z.z, 0), new Vector4(${v}.origin.x, ${v}.origin.y, ${v}.origin.z, 1))`,
  },
  Transform3D: {
    arg: "Projection",
    safe: (v) =>
      `new Transform3D(new Basis(new Vector3(${v}.x.x, ${v}.x.y, ${v}.x.z), new Vector3(${v}.y.x, ${v}.y.y, ${v}.y.z), new Vector3(${v}.z.x, ${v}.z.y, ${v}.z.z)), ` +
      `new Vector3(${v}.w.x, ${v}.w.y, ${v}.w.z))`,
  },
};

export function badConversion(node: ts.Node, checker: ts.TypeChecker): ValueProblem | null {
  if (!ts.isNewExpression(node)) return null;
  const cls = engineClassRef(node.expression, checker);
  const rule = cls ? BAD_CONVERSIONS[cls] : undefined;
  const args = node.arguments ?? [];
  if (!cls || !rule || args.length !== 1 || typeOf(args[0], checker) !== rule.arg) return null;
  const v = nameFor(args[0]);
  return {
    node,
    ticket: "262",
    message:
      `new ${cls}(${args[0].getText()}) with a ${rule.arg} returns garbage with no error (the binding reads the argument as a ${cls}). ` +
      `Write ${rule.safe(v)}${v === "v" ? " (with the value in a variable v)" : ""}.`,
  };
}

// -- 267: a value type turned into text -------------------------------------------------------------------------------

function isStringy(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  expr = strip(expr);
  return ts.isStringLiteralLike(expr) || ts.isTemplateExpression(expr) || (checker.getTypeAtLocation(expr).flags & ts.TypeFlags.StringLike) !== 0;
}

function isGlobalNamed(expr: ts.Expression, name: string, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(expr) || expr.text !== name) return false;
  return !userDeclared(checker.getSymbolAtLocation(expr));
}

const STRING_SAFE = "Use `str(v)` (import { str } from \"godot\": GDScript's text, `(1.0, 2.5, -3.0)`), log it with console.log(v), or write the fields (`${v.x}, ${v.y}`).";

/** Value-typed expressions that end up as `[object Object]` / `{}` at `node` (it reports on the node where the text is made). */
export function stringProblems(node: ts.Node, checker: ts.TypeChecker): ValueProblem[] {
  const out: ValueProblem[] = [];
  const report = (at: ts.Expression, how: string, safe = STRING_SAFE): void => {
    const t = typeOf(at, checker);
    if (!t || !STRINGLESS_TYPES.has(t)) return;
    out.push({
      node: at,
      ticket: "267",
      message: `\`${at.getText()}\` is a ${t}: ${how} gives \`[object Object]\` (or \`{}\`), the builtin types have no toString. ${safe.replace(/\bv\b/g, nameFor(at))}`,
    });
  };
  if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent)) {
    for (const span of node.templateSpans) report(span.expression, "a template literal");
  } else if (ts.isCallExpression(node)) {
    const callee = strip(node.expression);
    if (isGlobalNamed(callee, "String", checker) && node.arguments.length === 1) report(node.arguments[0], "String(v)");
    else if (
      ts.isPropertyAccessExpression(callee) && callee.name.text === "stringify" && isGlobalNamed(callee.expression, "JSON", checker) && node.arguments.length > 0
    ) {
      const arg = strip(node.arguments[0]);
      const jsonSafe = "Save the fields (`{ x: v.x, y: v.y, z: v.z }`) or the text `var_to_str(v)` (import from \"godot\"); JSON.stringify sees no own properties.";
      if (ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) {
          if (ts.isPropertyAssignment(p)) report(p.initializer, "JSON.stringify", jsonSafe);
          else if (ts.isShorthandPropertyAssignment(p)) report(p.name, "JSON.stringify", jsonSafe);
        }
      } else if (ts.isArrayLiteralExpression(arg)) for (const e of arg.elements) report(e, "JSON.stringify", jsonSafe);
      else report(arg, "JSON.stringify", jsonSafe);
    } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "toString" && node.arguments.length === 0) {
      report(callee.expression, "toString()");
    }
  } else if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.PlusToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) {
    if (isStringy(node.left, checker)) report(node.right, "adding it to a string");
    else if (node.operatorToken.kind === ts.SyntaxKind.PlusToken && isStringy(node.right, checker)) report(node.left, "adding it to a string");
  }
  return out;
}

// -- 268: iterating a Packed*Array ------------------------------------------------------------------------------------

/** for...of, spread, destructuring and Array.from of a Packed*Array (a build warning: none of them works). */
export function packedProblems(node: ts.Node, checker: ts.TypeChecker): ValueProblem[] {
  const subjects: { expr: ts.Expression; how: string; fromArray?: boolean }[] = [];
  if (ts.isForOfStatement(node)) subjects.push({ expr: node.expression, how: "for...of" });
  else if (ts.isSpreadElement(node)) subjects.push({ expr: node.expression, how: "spread" });
  else if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer) subjects.push({ expr: node.initializer, how: "array destructuring" });
  else if (ts.isCallExpression(node)) {
    const callee = strip(node.expression);
    if (
      ts.isPropertyAccessExpression(callee) && callee.name.text === "from" && isGlobalNamed(callee.expression, "Array", checker) && node.arguments.length > 0
    ) {
      subjects.push({ expr: node.arguments[0], how: "Array.from", fromArray: true });
    }
  }
  const out: ValueProblem[] = [];
  for (const { expr, how, fromArray } of subjects) {
    const t = typeOf(expr, checker);
    if (!t || !PACKED_TYPES.has(t)) continue;
    const p = nameFor(expr);
    const named = p === "v" ? "p" : p;
    out.push({
      node: expr,
      ticket: "268",
      message:
        `\`${expr.getText()}\` is a ${t}: ${how} ${fromArray ? "returns an EMPTY array with no error" : "throws \"value is not iterable\""} (no Packed array is iterable). ` +
        `Copy it with \`Array.from({ length: ${named}.size() }, (_, i) => ${named}.get(i))\` or loop \`for (let i = 0; i < ${named}.size(); i++) { const x = ${named}.get(i); ... }\`` +
        `${p === "v" ? " (with the array in a variable p)" : ""}.`,
    });
  }
  return out;
}
