// Build-time ERRORS for calls that kill or hang the engine process (engine tickets 80, 81, 82, 83, 84, 85). Read-only like
// diagnostics.ts: nothing is rewritten, ADR 0009 allows a pure validation. Each check fires only when the type is KNOWN:
// from the checker (the stand-in typings declare a few classes), or from the NAME of a class imported from "godot"
// (the program has no declaration for most engine classes), or from a const / annotated variable that says so.
// Any / unresolved / a user class of the same name stays silent ("silent rather than wrong"). Switch: `abortGuards` (options.ts).
import ts from "typescript";
import { engineIsA, importedEngineClass } from "./engine-classes.ts";
import { declaredByEngine } from "./ts-utils.ts";

export interface AbortProblem {
  ticket: string;
  message: string;
}

// Ticket 80: the constructor overload that takes these argument types reads the Variant with the wrong template and aborts.
const CTOR_ABORTS: Record<string, { arg: string; fields: string[] }> = {
  Vector2: { arg: "Vector2i", fields: ["x", "y"] },
  Vector2i: { arg: "Vector2i", fields: ["x", "y"] },
  Vector3: { arg: "Vector3i", fields: ["x", "y", "z"] },
  Vector3i: { arg: "Vector3i", fields: ["x", "y", "z"] },
  Vector4: { arg: "Vector4i", fields: ["x", "y", "z", "w"] },
  Vector4i: { arg: "Vector4i", fields: ["x", "y", "z", "w"] },
  Rect2: { arg: "Rect2i", fields: ["position.x", "position.y", "size.x", "size.y"] },
  Rect2i: { arg: "Rect2i", fields: ["position.x", "position.y", "size.x", "size.y"] },
};

// Ticket 81: the Array(PackedXArray) constructors.
const PACKED = new Set([
  "PackedByteArray", "PackedInt32Array", "PackedInt64Array", "PackedFloat32Array", "PackedFloat64Array",
  "PackedStringArray", "PackedVector2Array", "PackedVector3Array", "PackedColorArray", "PackedVector4Array",
]);

// Ticket 84: classes the engine refuses to instantiate outside the editor (proven ones only).
const EDITOR_ONLY = new Set(["GridMapEditorPlugin", "ScriptCreateDialog"]);

export function strip(expr: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr)) expr = expr.expression;
  return expr;
}

function isConstDeclaration(decl: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(decl.parent) && (decl.parent.flags & ts.NodeFlags.Const) !== 0;
}

/** `Vector2` or `G.Vector2` (namespace import of "godot"): the engine class name the expression names, or null. */
export function engineClassRef(expr: ts.Expression, checker: ts.TypeChecker): string | null {
  expr = strip(expr);
  if (ts.isIdentifier(expr)) return importedEngineClass(expr, checker);
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    for (const decl of checker.getSymbolAtLocation(expr.expression)?.declarations ?? []) {
      if (!ts.isNamespaceImport(decl)) continue;
      const from = decl.parent.parent.moduleSpecifier;
      if (ts.isStringLiteral(from) && from.text === "godot") return expr.name.text;
    }
  }
  return null;
}

export function typeRefName(node: ts.TypeNode, checker: ts.TypeChecker): string | null {
  if (ts.isUnionTypeNode(node)) {
    const isNullish = (t: ts.TypeNode) =>
      t.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword);
    const rest = node.types.filter((t) => !isNullish(t));
    return rest.length === 1 ? typeRefName(rest[0], checker) : null;
  }
  if (ts.isParenthesizedTypeNode(node)) return typeRefName(node.type, checker);
  if (!ts.isTypeReferenceNode(node)) return null;
  return ts.isIdentifier(node.typeName) ? importedEngineClass(node.typeName, checker) : null;
}

/** The engine class an expression has, or null when it cannot be told (then nothing is reported). */
export function engineTypeName(expr: ts.Expression, checker: ts.TypeChecker, depth = 0): string | null {
  expr = strip(expr);
  if (depth > 4) return null;
  if (ts.isAsExpression(expr)) return typeRefName(expr.type, checker);
  if (ts.isNewExpression(expr)) return engineClassRef(expr.expression, checker);
  // Constants of a value type: Vector2i.ZERO, Vector2i.ONE.
  if (ts.isPropertyAccessExpression(expr) && /^[A-Z][A-Z0-9_]*$/.test(expr.name.text)) {
    const cls = engineClassRef(expr.expression, checker);
    if (cls) return cls;
  }
  const symbol = checker.getTypeAtLocation(expr).getSymbol();
  if (symbol && declaredByEngine(symbol)) return symbol.getName();
  if (ts.isIdentifier(expr)) {
    const decl = checker.getSymbolAtLocation(expr)?.valueDeclaration;
    if (decl && (ts.isVariableDeclaration(decl) || ts.isParameter(decl) || ts.isPropertyDeclaration(decl))) {
      if (decl.type) return typeRefName(decl.type, checker);
      if (ts.isVariableDeclaration(decl) && decl.initializer && isConstDeclaration(decl)) {
        return engineTypeName(decl.initializer, checker, depth + 1);
      }
    }
  }
  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    for (let n: ts.Node | undefined = expr.parent; n; n = n.parent) {
      if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) return null; // own `this`
      if (!ts.isClassLike(n)) continue;
      const base = n.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
      return base ? engineClassRef(base.expression, checker) : null;
    }
  }
  return null;
}

// Only the inline `new PackedVector2Array()`: a variable that starts empty is usually filled before the call.
function isEmptyPackedVector2Array(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  expr = strip(expr);
  return ts.isNewExpression(expr) && engineClassRef(expr.expression, checker) === "PackedVector2Array" && (expr.arguments?.length ?? 0) === 0;
}

/** The argument's text when it is a plain name or member chain, else a placeholder `v` (the message says to store it first). */
export function nameFor(arg: ts.Expression): string {
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(arg.getText()) ? arg.getText() : "v";
}

function isNegativeNumber(expr: ts.Expression): boolean {
  expr = strip(expr);
  return (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand) &&
    Number(expr.operand.text.replace(/_/g, "")) > 0
  );
}

/** Build-time diagnosis for one node, or null. Only NewExpression, CallExpression and `=` assignments are looked at. */
export function abortProblem(node: ts.Node, checker: ts.TypeChecker): AbortProblem | null {
  if (ts.isNewExpression(node)) {
    const cls = engineClassRef(node.expression, checker);
    if (!cls) return null;
    const args = node.arguments ?? [];
    const rule = CTOR_ABORTS[cls];
    if (rule && args.length === 1 && engineTypeName(args[0], checker) === rule.arg) {
      const v = nameFor(args[0]);
      return {
        ticket: "80",
        message:
          `new ${cls}(${args[0].getText()}) aborts the engine process (FATAL in the constructor overload for ${rule.arg}; no script error to catch). ` +
          `Pass the components: new ${cls}(${rule.fields.map((f) => `${v}.${f}`).join(", ")})${v === "v" ? " (with the value in a variable v)" : ""}.`,
      };
    }
    if (cls === "Basis" && args.length === 1 && engineTypeName(args[0], checker) === "Quaternion") {
      const v = nameFor(args[0]);
      return {
        ticket: "80",
        message: `new Basis(${args[0].getText()}) with a Quaternion crashes the engine process (signal 11). Use Basis.from_euler(${v}.get_euler()).`,
      };
    }
    if (cls === "GArray" && args.length === 1) {
      const t = engineTypeName(args[0], checker);
      if (t && PACKED.has(t)) {
        const v = nameFor(args[0]);
        return {
          ticket: "81",
          message:
            `new GArray(${args[0].getText()}) with a ${t} kills the engine process (the Array(Packed...) constructors crash). ` +
            `Copy the elements: const a = new GArray(); for (let i = 0; i < ${v}.size(); i++) a.push_back(${v}.get(i)).`,
        };
      }
    }
    if (EDITOR_ONLY.has(cls)) {
      return {
        ticket: "84",
        message:
          `new ${cls}() only works inside the editor: the engine prints "can only be instantiated by editor" and returns a wrapper around nothing, ` +
          "so the next method call crashes the process. Do not instantiate it from a game script.",
      };
    }
    return null;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    const receiver = node.expression.expression;
    if (method === "unreference" && node.arguments.length === 0) {
      const t = engineTypeName(receiver, checker);
      if (t && (t === "RefCounted" || engineIsA(t, "RefCounted") === true)) {
        return {
          ticket: "82",
          message:
            `${receiver.getText()}.unreference() on a script-held ${t} drops the count below the wrapper's own: the engine prints FATAL ref_count_ > 0 and the process then never exits. ` +
            "Never call reference()/unreference()/init_ref(); drop the JS reference instead (use weakref() to watch the object).",
        };
      }
    }
    if (
      method === "offset_polyline" &&
      node.arguments.length > 0 &&
      engineClassRef(receiver, checker) === "Geometry2D" &&
      isEmptyPackedVector2Array(node.arguments[0], checker)
    ) {
      return {
        ticket: "85",
        message:
          "Geometry2D.offset_polyline() with an empty polyline crashes the engine process (signal 11). " +
          "Check the polyline first: if (points.size() > 0) { ... }.",
      };
    }
    return null;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left) &&
    node.left.name.text === "input_count" &&
    isNegativeNumber(node.right)
  ) {
    const t = engineTypeName(node.left.expression, checker);
    if (t && (t === "AnimationNodeTransition" || engineIsA(t, "AnimationNodeTransition") === true)) {
      return {
        ticket: "83",
        message:
          `${node.left.getText()} = ${node.right.getText()}: a negative input_count makes the engine print out-of-bounds errors forever (the call never returns). ` +
          "Use a count of 0 or more.",
      };
    }
  }
  return null;
}
