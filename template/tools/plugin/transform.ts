// Type-aware text edits. The checker reads declared types; the bytes Bun compiles stay TypeScript.
import ts from "typescript";
import { applyEdits, toTransformMap, type Edit, type Part, type TransformMap } from "./sourcemap.ts";

const TYPE_BOOL = 1;
const TYPE_INT = 2;
const TYPE_FLOAT = 3;
const TYPE_STRING = 4;
const TYPE_VECTOR2 = 5;
const TYPE_VECTOR3 = 9;
const TYPE_COLOR = 20;
const TYPE_OBJECT = 24;
const TYPE_ARRAY = 28;
const HINT_ENUM = 2;
const HINT_RESOURCE = 17;
const HINT_TYPE_STRING = 23;
const HINT_NODE = 34;

const CALL_METHODS = new Set(["connect", "disconnect", "is_connected", "tween_callback"]);
// GArray.filter/map take Callable on the stock bridge. A JS Array method with the same name must not be wrapped.
const GARRAY_METHODS = new Set(["filter", "map"]);

export interface TransformResult {
  map: TransformMap;
  warnings: string[];
}

type Kind =
  | { kind: "builtin"; hint: string; scalar: number }
  | { kind: "resource"; name: string }
  | { kind: "node"; name: string };

function loc(node: ts.Node): string {
  const sf = node.getSourceFile();
  const pos = sf.getLineAndCharacterOfPosition(node.getStart());
  return `${sf.fileName}:${pos.line + 1}:${pos.character + 1}`;
}

function fail(node: ts.Node, message: string): never {
  throw new Error(`${loc(node)} ${message}`);
}

function isAnyOrError(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Any) !== 0 || (type as { intrinsicName?: string }).intrinsicName === "error";
}

function gen(text: string, at: number): Part {
  return { text, at };
}

function copy(text: string, from: number): Part {
  return { text, from };
}

export function transformSourceFile(sf: ts.SourceFile, checker: ts.TypeChecker): TransformResult | null {
  const source = sf.getFullText();
  const edits: Edit[] = [];
  const warnings: string[] = [];
  let needCallable = false;
  let needOwner = false;
  const callableLocal = findCallableLocal(sf);

  const replace = (start: number, end: number, parts: Part[]) => {
    edits.push({ start, end, parts });
  };

  const considerCall = (node: ts.CallExpression) => {
    if (isSetScript(node)) {
      if (!isGdScriptArg(node.arguments[0])) {
        warnings.push(
          `${loc(node)} set_script() does not run a JS class constructor on the stock engine, so accessor fields stay uninitialised. Use ResourceLoader.load(path).call("new") for a new instance. Flagged, not rewritten.`,
        );
      }
      return;
    }

    if (isTwoArgCallableCreate(node, callableLocal)) {
      const fn = node.arguments[1];
      if (ts.isStringLiteral(fn) || ts.isNoSubstitutionTemplateLiteral(fn)) return;
      if (!isFunctionLike(fn, checker)) {
        fail(
          fn,
          "Callable.create(owner, fn): the plugin cannot see a function here (any, unresolved, or not a function). Pass a function or an arrow.",
        );
      }
      const owner = node.arguments[0];
      const ownerText = source.slice(owner.getStart(), owner.getEnd());
      const fnText = source.slice(fn.getStart(), fn.getEnd());
      needOwner = true;
      replace(node.getStart(), node.getEnd(), [
        gen("callableWithOwner(", node.getStart()),
        copy(ownerText, owner.getStart()),
        gen(", ", node.getStart()),
        copy(fnText, fn.getStart()),
        gen(")", node.getStart()),
      ]);
      return;
    }

    const exportKind = exportMethod(node);
    if (exportKind) {
      const arg = node.arguments[0];
      if (!arg) fail(node, `export.${exportKind}() needs a class argument.`);
      const kind = classifyExpression(arg, checker);
      const hint = hintFor(exportKind, kind, arg);
      const callee = node.expression as ts.PropertyAccessExpression;
      const head = source.slice(callee.expression.getStart(), callee.expression.getEnd());
      const options =
        hint.hint === undefined
          ? ""
          : `, { hint: ${hint.hint}, hint_string: ${JSON.stringify(hint.hintString)} }`;
      replace(node.getStart(), node.getEnd(), [
        gen(`${head}(${hint.type}${options})`, node.getStart()),
      ]);
      return;
    }

    if (isBareGdExport(node)) {
      rewriteBareExport(node, sf, checker, replace);
      return;
    }

    const argIndex = callableArgIndex(node, checker);
    if (argIndex === null) return;
    const arg = node.arguments[argIndex];
    if (!arg || isCallableFactory(arg)) return;
    if (!isFunctionLike(arg, checker)) return;
    const argText = source.slice(arg.getStart(), arg.getEnd());
    const local = callableLocal ?? "Callable";
    needCallable = callableLocal === null;
    replace(arg.getStart(), arg.getEnd(), [
      gen(`${local}.create(`, arg.getStart()),
      copy(argText, arg.getStart()),
      gen(")", arg.getStart()),
    ]);
  };

  const considerClass = (node: ts.ClassLikeDeclaration) => {
    const fields = onreadyFields(node);
    if (fields.length === 0) return;
    for (const field of fields) {
      replace(field.decorator.getStart(), field.decorator.getEnd(), []);
    }
    const parts: Part[] = [gen("\n", fields[0].decorator.getStart())];
    for (const field of fields) parts.push(...onreadyParts(field, source));
    const ready = findReady(node);
    if (ready && ready.body && ts.isBlock(ready.body)) {
      const brace = ready.body.getStart();
      replace(brace + 1, brace + 1, parts);
      return;
    }
    const close = node.getEnd() - 1;
    replace(close, close, [
      gen("\n_ready(): void {", fields[0].decorator.getStart()),
      ...parts,
      gen("}\n", fields[0].decorator.getStart()),
    ]);
  };

  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node)) considerCall(node);
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) considerClass(node);
    ts.forEachChild(node, walk);
  };
  walk(sf);

  if (needOwner) {
    edits.push({
      start: 0,
      end: 0,
      parts: [gen('import { callableWithOwner } from "godotjs-tooling/callable";\n', 0)],
    });
  }
  if (needCallable) ensureCallableImport(sf, edits);

  if (edits.length === 0) return warnings.length ? { map: identityMap(source), warnings } : null;
  // Warnings with no edits still return null from the caller when the map is identity.
  // Keep identity out of the bundle path: if the only edits are empty, skip.
  const meaningful = edits.some((edit) => edit.parts.length > 0 || edit.end > edit.start);
  if (!meaningful) return warnings.length ? { map: identityMap(source), warnings } : null;

  const applied = applyEdits(source, edits);
  return { map: toTransformMap(source, applied.text, applied.ranges), warnings };
}

function identityMap(source: string): TransformMap {
  const applied = applyEdits(source, []);
  return toTransformMap(source, applied.text, applied.ranges);
}

function findCallableLocal(sf: ts.SourceFile): string | null {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier) || stmt.moduleSpecifier.text !== "godot") continue;
    const named = stmt.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const imported = el.propertyName?.text ?? el.name.text;
      if (imported === "Callable") return el.name.text;
    }
  }
  return null;
}

function ensureCallableImport(sf: ts.SourceFile, edits: Edit[]) {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier) || stmt.moduleSpecifier.text !== "godot") continue;
    const named = stmt.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      const end = named.getEnd() - 1;
      edits.push({ start: end, end, parts: [gen(", Callable", stmt.getStart())] });
      return;
    }
  }
  edits.push({
    start: 0,
    end: 0,
    parts: [gen('import { Callable } from "godot";\n', 0)],
  });
}

function isSetScript(node: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "set_script";
}

function isGdScriptArg(arg: ts.Expression | undefined): boolean {
  if (!arg) return false;
  const text = arg.getText();
  return text.includes(".gd\"") || text.includes(".gd'");
}

function isTwoArgCallableCreate(node: ts.CallExpression, callableLocal: string | null): boolean {
  if (node.arguments.length !== 2) return false;
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "create") return false;
  if (!ts.isIdentifier(node.expression.expression)) return false;
  const name = node.expression.expression.text;
  return name === (callableLocal ?? "Callable") || name === "Callable";
}

function isGArrayReceiver(recv: ts.Expression, checker: ts.TypeChecker): boolean {
  const type = checker.getTypeAtLocation(recv);
  const symbol = type.getSymbol();
  if (!symbol) return false;
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return resolved.getName() === "GArray";
}

function isCallableFactory(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const name = node.expression.name.text;
  return name === "create" || name === "callableWithOwner";
}

function exportMethod(node: ts.CallExpression): "array" | "object" | null {
  if (node.arguments.length < 1) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (callee.name.text !== "array" && callee.name.text !== "object") return null;
  if (!ts.isPropertyAccessExpression(callee.expression) || callee.expression.name.text !== "export") return null;
  return callee.name.text;
}

function isBareGdExport(node: ts.CallExpression): boolean {
  if (node.arguments.length !== 0) return false;
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "export") return false;
  return ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "gd";
}

function callableArgIndex(node: ts.CallExpression, checker: ts.TypeChecker): number | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  const name = node.expression.name.text;
  if (GARRAY_METHODS.has(name)) {
    if (!isGArrayReceiver(node.expression.expression, checker)) return null;
    return node.arguments.length >= 1 ? 0 : null;
  }
  if (!CALL_METHODS.has(name)) return null;
  if (name === "tween_callback") return node.arguments.length >= 1 ? 0 : null;
  const first = node.arguments[0];
  if (!first) return null;
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
    return node.arguments.length >= 2 ? 1 : null;
  }
  return 0;
}

function hasCallSignature(type: ts.Type): boolean {
  if (type.isUnion()) {
    return type.types.some(
      (part) => !(part.flags & ts.TypeFlags.Null) && !(part.flags & ts.TypeFlags.Undefined) && hasCallSignature(part),
    );
  }
  return type.getCallSignatures().length > 0;
}

function isFunctionLike(node: ts.Expression, checker: ts.TypeChecker): boolean {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (isCallableFactory(node)) return false;
  const type = checker.getTypeAtLocation(node);
  if (hasCallSignature(type)) return true;
  if (isCallableInstance(type)) return false;
  if (isAnyOrError(type)) {
    fail(
      node,
      "cannot tell whether this value is a function or a Callable (type is any or unresolved). Pass a function, an arrow, or Callable.create(...).",
    );
  }
  return false;
}

function isCallableInstance(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some((part) => isCallableInstance(part));
  return type.getSymbol()?.getName() === "Callable";
}

function hintFor(
  method: "array" | "object",
  kind: Kind,
  arg: ts.Expression,
): { type: number; hint?: number; hintString: string } {
  if (method === "array") {
    const hintString =
      kind.kind === "builtin"
        ? kind.hint
        : kind.kind === "resource"
          ? `${TYPE_OBJECT}/${HINT_RESOURCE}:${kind.name}`
          : `${TYPE_OBJECT}/${HINT_NODE}:${kind.name}`;
    return { type: TYPE_ARRAY, hint: HINT_TYPE_STRING, hintString };
  }
  if (kind.kind === "builtin") {
    fail(arg, `export.object() does not take ${arg.getText()}. Use a Resource or Node class.`);
  }
  if (kind.kind === "resource") return { type: TYPE_OBJECT, hint: HINT_RESOURCE, hintString: kind.name };
  return { type: TYPE_OBJECT, hint: HINT_NODE, hintString: kind.name };
}

function classifyExpression(arg: ts.Expression, checker: ts.TypeChecker): Kind {
  const type = checker.getTypeAtLocation(arg);
  if (isAnyOrError(type)) {
    fail(
      arg,
      `cannot resolve export type of \`${arg.getText()}\` (any or unresolved). Name a concrete class: String, IntegerType, Resource, Node, or a class that extends Resource or Node.`,
    );
  }
  const located = expressionSymbol(arg, checker) ?? type.getSymbol();
  const builtin = builtinKind(located?.getName() ?? "");
  if (builtin) return builtin;
  if (located?.getName() === "StringConstructor") return builtinKind("String")!;
  return classifySymbol(located, arg, checker);
}

function expressionSymbol(arg: ts.Expression, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) return checker.getSymbolAtLocation(arg);
  return checker.getTypeAtLocation(arg).getSymbol();
}

function builtinKind(name: string): Kind | null {
  if (name === "String") return { kind: "builtin", hint: `${TYPE_STRING}:`, scalar: TYPE_STRING };
  if (name === "Boolean") return { kind: "builtin", hint: `${TYPE_BOOL}:`, scalar: TYPE_BOOL };
  if (name === "Number") return { kind: "builtin", hint: `${TYPE_FLOAT}:`, scalar: TYPE_FLOAT };
  if (name === "IntegerType") return { kind: "builtin", hint: `${TYPE_INT}:`, scalar: TYPE_INT };
  if (name === "FloatType") return { kind: "builtin", hint: `${TYPE_FLOAT}:`, scalar: TYPE_FLOAT };
  if (name === "Vector2") return { kind: "builtin", hint: `${TYPE_VECTOR2}:`, scalar: TYPE_VECTOR2 };
  if (name === "Vector3") return { kind: "builtin", hint: `${TYPE_VECTOR3}:`, scalar: TYPE_VECTOR3 };
  if (name === "Color") return { kind: "builtin", hint: `${TYPE_COLOR}:`, scalar: TYPE_COLOR };
  return null;
}

function declaredName(symbol: ts.Symbol): string {
  for (const decl of symbol.declarations ?? []) {
    if ((ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl)) && decl.name) return decl.name.text;
  }
  const name = symbol.getName();
  if (name === "default") {
    failNode(symbol);
  }
  return name;
}

function failNode(symbol: ts.Symbol): never {
  const decl = symbol.declarations?.[0];
  if (decl) {
    fail(decl, "default-exported class has no name. Godot's class_name comes from the class declaration (`export default class Person`).");
  }
  throw new Error("default-exported class has no name.");
}

function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  if (symbol.flags & ts.SymbolFlags.Alias) return checker.getAliasedSymbol(symbol);
  return symbol;
}

function classifySymbol(symbol: ts.Symbol | undefined, at: ts.Node, checker: ts.TypeChecker): Kind {
  if (!symbol) fail(at, "cannot resolve this export type. Name a concrete class.");
  symbol = resolveAlias(symbol, checker);
  if (symbol.flags & ts.SymbolFlags.TypeParameter) {
    fail(at, `export type \`${symbol.getName()}\` is a type parameter. The plugin needs a concrete class, not a generic.`);
  }
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (decl && (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl)) && decl.typeParameters?.length) {
    fail(
      at,
      `\`${symbol.getName()}\` is generic. A build-time hint needs a concrete class (the element type is erased at runtime).`,
    );
  }
  const name = declaredName(symbol);
  const builtin = builtinKind(name);
  if (builtin) return builtin;
  const chain = baseNames(symbol, checker);
  if (name === "Node" || chain.includes("Node")) return { kind: "node", name };
  if (name === "Resource" || chain.includes("Resource")) return { kind: "resource", name };
  fail(
    at,
    `cannot classify export type \`${name}\`. It is not String, a number marker, or a class that extends Resource or Node.`,
  );
}

function baseNames(symbol: ts.Symbol, checker: ts.TypeChecker): string[] {
  const names: string[] = [];
  const seen = new Set<ts.Symbol>();
  const walk = (sym: ts.Symbol | undefined) => {
    if (!sym || seen.has(sym)) return;
    seen.add(sym);
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!decl || !ts.isClassDeclaration(decl) || !decl.heritageClauses) return;
    for (const clause of decl.heritageClauses) {
      for (const heritage of clause.types) {
        const raw = checker.getSymbolAtLocation(heritage.expression) ?? checker.getTypeAtLocation(heritage).getSymbol();
        if (!raw) continue;
        const base = resolveAlias(raw, checker);
        names.push(base.getName());
        walk(base);
      }
    }
  };
  walk(symbol);
  return names;
}

function rewriteBareExport(
  node: ts.CallExpression,
  _sf: ts.SourceFile,
  checker: ts.TypeChecker,
  replace: (start: number, end: number, parts: Part[]) => void,
) {
  const decorator = node.parent;
  if (!decorator || !ts.isDecorator(decorator) || decorator.parent == null || !ts.isPropertyDeclaration(decorator.parent)) {
    fail(node, "@gd.export() must decorate a field or accessor.");
  }
  const prop = decorator.parent;
  if (!prop.type) {
    fail(prop, "@gd.export() needs a type annotation. Example: accessor speed: number = 200.0");
  }
  const type = checker.getTypeFromTypeNode(prop.type);
  const spec = exportSpecFromType(type, prop, checker);
  const callee = node.expression as ts.PropertyAccessExpression;
  const head = prop.getSourceFile().text.slice(callee.getStart(), callee.getEnd());
  const args =
    spec.hint === undefined
      ? String(spec.type)
      : `${spec.type}, { hint: ${spec.hint}, hint_string: ${JSON.stringify(spec.hintString)} }`;
  replace(node.getStart(), node.getEnd(), [gen(`${head}(${args})`, node.getStart())]);
}

function exportSpecFromType(
  type: ts.Type,
  prop: ts.PropertyDeclaration,
  checker: ts.TypeChecker,
): { type: number; hint?: number; hintString: string } {
  const nonNull = unwrapNull(type);
  if (nonNull.isUnion()) {
    fail(prop, "@gd.export() cannot yet split a union. Use one type, or null.");
  }
  if (checker.isArrayType(nonNull) || isArrayRef(nonNull)) {
    const elem = arrayElement(nonNull, checker);
    if (!elem) fail(prop, "@gd.export() could not read this array's element type.");
    if (elem.flags & ts.TypeFlags.Number) {
      fail(
        prop,
        "number[] is ambiguous (Godot int vs float). Use a concrete element (string, Resource, Node) or @gd.export.array with IntegerType / FloatType.",
      );
    }
    if (isAnyOrError(elem)) {
      fail(prop, "array element type is any or unresolved. Name a concrete element class.");
    }
    const kind = kindFromType(elem, prop, checker);
    const hintString =
      kind.kind === "builtin"
        ? kind.hint
        : kind.kind === "resource"
          ? `${TYPE_OBJECT}/${HINT_RESOURCE}:${kind.name}`
          : `${TYPE_OBJECT}/${HINT_NODE}:${kind.name}`;
    return { type: TYPE_ARRAY, hint: HINT_TYPE_STRING, hintString };
  }
  if (nonNull.flags & ts.TypeFlags.String || nonNull.flags & ts.TypeFlags.StringLiteral) {
    return { type: TYPE_STRING, hintString: "" };
  }
  if (nonNull.flags & ts.TypeFlags.Boolean || nonNull.flags & ts.TypeFlags.BooleanLiteral) {
    return { type: TYPE_BOOL, hintString: "" };
  }
  if (nonNull.flags & ts.TypeFlags.Number || nonNull.flags & ts.TypeFlags.NumberLiteral) {
    const literal = numericKind(prop.initializer);
    if (!literal) {
      fail(
        prop,
        "@gd.export() on number needs a numeric literal so int and float can be told apart (200 vs 200.0). Otherwise use @gd.export.int() or @gd.export.float().",
      );
    }
    return { type: literal === "int" ? TYPE_INT : TYPE_FLOAT, hintString: "" };
  }
  if (isAnyOrError(nonNull)) {
    fail(prop, "@gd.export() type is any or unresolved. Annotate a concrete type.");
  }
  const enumHint = enumHintString(nonNull);
  if (enumHint) return { type: TYPE_INT, hint: HINT_ENUM, hintString: enumHint };
  const kind = kindFromType(nonNull, prop, checker);
  if (kind.kind === "builtin") return { type: kind.scalar, hintString: "" };
  if (kind.kind === "resource") return { type: TYPE_OBJECT, hint: HINT_RESOURCE, hintString: kind.name };
  return { type: TYPE_OBJECT, hint: HINT_NODE, hintString: kind.name };
}

function unwrapNull(type: ts.Type): ts.Type {
  if (!type.isUnion()) return type;
  const parts = type.types.filter((part) => !(part.flags & ts.TypeFlags.Null) && !(part.flags & ts.TypeFlags.Undefined));
  if (parts.length === 1) return parts[0];
  return type;
}

function isArrayRef(type: ts.Type): boolean {
  return type.getSymbol()?.getName() === "Array";
}

function arrayElement(type: ts.Type, checker: ts.TypeChecker): ts.Type | undefined {
  if (checker.isArrayType(type)) return checker.getTypeArguments(type as ts.TypeReference)[0];
  const args = checker.getTypeArguments(type as ts.TypeReference);
  return args[0];
}

function kindFromType(type: ts.Type, at: ts.Node, checker: ts.TypeChecker): Kind {
  if (type.flags & ts.TypeFlags.String) return { kind: "builtin", hint: `${TYPE_STRING}:`, scalar: TYPE_STRING };
  if (type.flags & ts.TypeFlags.Boolean) return { kind: "builtin", hint: `${TYPE_BOOL}:`, scalar: TYPE_BOOL };
  const symbol = type.getSymbol();
  if (!symbol) fail(at, "cannot resolve this type for an export hint.");
  return classifySymbol(symbol, at, checker);
}

function numericKind(node: ts.Expression | undefined): "int" | "float" | null {
  if (!node) return null;
  let text: string | null = null;
  if (ts.isNumericLiteral(node)) text = node.getText();
  else if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    text = node.operand.getText();
  }
  if (text == null) return null;
  return /[eE.]/.test(text) ? "float" : "int";
}

function enumHintString(type: ts.Type): string | null {
  const symbol = type.getSymbol();
  if (!symbol || !(symbol.flags & ts.SymbolFlags.Enum)) return null;
  const names: string[] = [];
  symbol.exports?.forEach((member, name) => {
    if (name === "prototype" || String(name).startsWith("__")) return;
    names.push(String(name));
  });
  return names.length ? names.join(",") : null;
}

interface OnreadyField {
  name: string;
  decorator: ts.Decorator;
  arg: ts.Expression;
}

function onreadyFields(node: ts.ClassLikeDeclaration): OnreadyField[] {
  const fields: OnreadyField[] = [];
  for (const member of node.members) {
    if (!ts.isPropertyDeclaration(member)) continue;
    const decorators = ts.getDecorators(member) ?? [];
    for (const decorator of decorators) {
      const call = decorator.expression;
      if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) continue;
      if (call.expression.name.text !== "onready") continue;
      if (!ts.isIdentifier(member.name)) {
        fail(member, "@onready field name must be an identifier.");
      }
      const arg = call.arguments[0];
      if (!arg) fail(decorator, "@onready() needs a string path or a function.");
      fields.push({ name: member.name.text, decorator, arg });
    }
  }
  return fields;
}

function onreadyParts(field: OnreadyField, source: string): Part[] {
  const at = field.decorator.getStart();
  const arg = field.arg;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    const lit = JSON.stringify(arg.text);
    const code = `try { const __n = this.get_node(${lit}); this.${field.name} = __n == null ? null : __n; } catch { this.${field.name} = null; }\n`;
    return [gen(code, at)];
  }
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    const fn = source.slice(arg.getStart(), arg.getEnd());
    const warn = `something wrong when evaluating onready '${field.name}'\n`;
    return [
      gen(`try { this.${field.name} = (`, at),
      copy(fn, arg.getStart()),
      gen(
        `).call(this, this); } catch (__e) { console.warn(${JSON.stringify(warn)} + String(__e)); this.${field.name} = null; }\n`,
        at,
      ),
    ];
  }
  fail(arg, "@onready argument must be a string path or a function. The plugin cannot evaluate an arbitrary expression.");
}

function findReady(node: ts.ClassLikeDeclaration): ts.MethodDeclaration | undefined {
  for (const member of node.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    if (ts.isIdentifier(member.name) && member.name.text === "_ready") return member;
  }
  return undefined;
}
