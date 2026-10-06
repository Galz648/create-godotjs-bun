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

export interface TransformOptions {
  /** Module specifier of the runtime half (src/lib/gd.ts). Used when a file needs `gd` and does not import it. */
  gdModule?: string;
  /** Scene knowledge for `@onready("Path")` validation (see scenes.ts). Absent: no scene check. */
  scenes?: { checkOnready(scriptFile: string, path: string, fieldType: string | null): string[] };
}

export function transformSourceFile(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  options: TransformOptions = {},
): TransformResult | null {
  const source = sf.getFullText();
  const edits: Edit[] = [];
  const warnings: string[] = [];
  let needCallable = false;
  let needOwner = false;
  let needGdImport = false;
  const callableLocal = findCallableLocal(sf);
  const gdImported = findGdLocal(sf);
  const gdName = gdImported ?? "gd";
  // The name generated code uses for the runtime half: the file's own `gd`, or an injected alias.
  const gdRef = () => {
    if (gdImported || usesGdIdentifier(sf)) return gdName;
    needGdImport = true;
    return "__gd";
  };

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
    if (!isFunctionLike(arg, checker)) {
      if (isEngineMethod(node, checker)) rejectNonCallable(arg, node, checker);
      return;
    }
    if (isEngineMethod(node, checker)) {
      if (thisUsingFunction(arg, checker)) {
        const shown = ts.isFunctionExpression(arg) ? "this function" : `\`${arg.getText()}\``;
        warnings.push(
          `${loc(arg)} ${shown} uses \`this\`, but the engine calls a function passed to ${(node.expression as ts.PropertyAccessExpression).name.text}() with no receiver, so \`this\` is undefined inside it. ` +
            "Pass an arrow function that calls it (`(...args) => this.method(...args)`) or Callable.create(owner, fn).",
        );
      }
    }
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
    considerRegistration(node);
    const fields = onreadyFields(node);
    if (fields.length === 0) return;
    for (const read of earlyOnreadyReads(node, fields.map((f) => f.name))) {
      warnings.push(
        `${loc(read)} \`${read.getText()}\` is an @onready field. It is assigned at the start of _ready, so this read in a field initializer or the constructor sees undefined.`,
      );
    }
    if (options.scenes) {
      for (const field of fields) {
        if (!ts.isStringLiteral(field.arg) && !ts.isNoSubstitutionTemplateLiteral(field.arg)) continue;
        const member = field.decorator.parent as ts.PropertyDeclaration;
        for (const message of options.scenes.checkOnready(sf.fileName, field.arg.text, declaredClassName(member.type))) {
          warnings.push(`${loc(field.decorator)} ${message}`);
        }
      }
    }
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
      // The generated _ready must not shadow an inherited one (a project base class). Engine classes
      // have no JS _ready, so the optional call is a no-op there. A class's own _ready is never touched.
      gen("super._ready?.();}\n", fields[0].decorator.getStart()),
    ]);
  };

  // Part of the class-registration rule: a script class is a default-exported class that extends a Godot
  // class. Member @gd decorators there register the class without an explicit @gd.class, and a Signal-typed
  // accessor with no decorator is a signal declaration. Anywhere else those decorators cannot work.
  const considerRegistration = (node: ts.ClassLikeDeclaration) => {
    const members = classGdMembers(node, gdName);
    const signalFields: ts.PropertyDeclaration[] = [];
    const nearMisses: ts.PropertyDeclaration[] = [];
    for (const member of node.members) {
      if (!ts.isPropertyDeclaration(member)) continue;
      if (member.initializer || hasModifier(member, ts.SyntaxKind.StaticKeyword)) continue;
      if (hasModifier(member, ts.SyntaxKind.DeclareKeyword)) continue;
      if (!isSignalTyped(member, checker)) continue;
      if (members.some((m) => m.member === member && m.name === "signal")) continue;
      if (hasModifier(member, ts.SyntaxKind.AccessorKeyword)) signalFields.push(member);
      else nearMisses.push(member);
    }
    if (members.length === 0 && signalFields.length === 0 && nearMisses.length === 0) return;
    const script = isScriptClass(node, checker);
    if (!script) {
      const first = members[0];
      if (first) {
        fail(
          first.decorator,
          `@${gdName}.${first.name}() is on class ${node.name?.text ?? "(anonymous)"}, ${scriptClassProblem(node, checker)}. ` +
            "Exports, signals and @onready only work on a script class: the default export of its file, extending a Godot class.",
        );
      }
      return;
    }
    for (const entry of members) {
      if (entry.name === "onready") continue;
      const member = entry.member;
      const isAccessor = ts.isPropertyDeclaration(member) && hasModifier(member, ts.SyntaxKind.AccessorKeyword);
      if (!ts.isPropertyDeclaration(member) || !isAccessor || hasModifier(member, ts.SyntaxKind.StaticKeyword)) {
        const label = memberLabel(member);
        fail(
          entry.decorator,
          `@${gdName}.${entry.name}() on \`${label}\` needs an instance \`accessor\` field (\`@${gdName}.${entry.name}() accessor ${label}${entry.name === "signal" ? "!: Signal<...>" : ": type = value"}\`). ` +
            "On a plain field, a method or a static member the engine throws \"no setter for property\" when it constructs the class.",
        );
      }
    }
    for (const field of nearMisses) {
      fail(
        field,
        `\`${memberLabel(field)}\` is typed Signal but is not an \`accessor\`, so it is not a signal declaration. ` +
          `Write \`accessor ${memberLabel(field)}!: Signal<...>\` to declare it. A Signal-typed field with an initializer is left alone.`,
      );
    }
    if (members.length === 0 && signalFields.length === 0) return;
    const ref = gdRef();
    for (const field of signalFields) {
      replace(field.getStart(), field.getStart(), [gen(`@${ref}.signal() `, field.getStart())]);
    }
    if (!hasClassDecorator(node, gdName)) {
      const at = node.getStart();
      replace(at, at, [gen(`@${ref}.class `, at)]);
    }
  };

  const considerExpression = (node: ts.Node) => {
    const copied = mutatedCopy(node, checker);
    if (copied) {
      warnings.push(
        `${loc(copied.target)} \`${copied.target.getText()}\` changes a temporary copy: reading \`${copied.inner.getText()}\` from the engine returns a new ${copied.typeName}, ` +
          `so this assignment is lost. Assign the whole value (\`${copied.inner.getText()} = new ${copied.typeName}(...)\`) or modify a local and assign it back.`,
      );
    }
    if (ts.isAwaitExpression(node) && isSignalExpression(node.expression, checker)) {
      warnings.push(
        `${loc(node)} \`await ${node.expression.getText()}\` does not wait: a Signal is not a Promise in JS, so the await resolves at once. Use \`await ${node.expression.getText()}.as_promise()\`.`,
      );
    }
  };

  const walk = (node: ts.Node) => {
    considerExpression(node);
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
  if (needGdImport) {
    edits.push({
      start: 0,
      end: 0,
      parts: [gen(`import { gd as __gd } from ${JSON.stringify(options.gdModule ?? "")};\n`, 0)],
    });
  }

  if (edits.length === 0) return warnings.length ? { map: identityMap(source), warnings } : null;
  // Warnings with no edits still return null from the caller when the map is identity.
  // Keep identity out of the bundle path: if the only edits are empty, skip.
  const meaningful = edits.some((edit) => edit.parts.length > 0 || edit.end > edit.start);
  if (!meaningful) return warnings.length ? { map: identityMap(source), warnings } : null;

  const applied = applyEdits(source, edits);
  return { map: toTransformMap(source, applied.text, applied.ranges), warnings };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function memberLabel(member: ts.ClassElement): string {
  return member.name ? member.name.getText() : "(unnamed)";
}

// `import { gd } from "./lib/gd"` (any specifier except the engine's own modules).
function findGdLocal(sf: ts.SourceFile): string | null {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (stmt.moduleSpecifier.text === "godot" || stmt.moduleSpecifier.text === "godot.annotations") continue;
    const named = stmt.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if ((el.propertyName?.text ?? el.name.text) === "gd") return el.name.text;
    }
  }
  return null;
}

// A file that declares or uses `gd` without importing it (a test stub, a global declaration).
function usesGdIdentifier(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isDecorator(node) && decoratorPath(node)?.root === "gd") found = true;
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// `@gd.export.int()` -> { root: "gd", names: ["export", "int"] }
function decoratorPath(decorator: ts.Decorator): { root: string; names: string[] } | null {
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

interface GdMember {
  member: ts.ClassElement;
  decorator: ts.Decorator;
  name: string;
}

function classGdMembers(node: ts.ClassLikeDeclaration, gdName: string): GdMember[] {
  const found: GdMember[] = [];
  for (const member of node.members) {
    for (const decorator of ts.getDecorators(member as ts.HasDecorators) ?? []) {
      const path = decoratorPath(decorator);
      if (!path || path.root !== gdName || path.names.length === 0) continue;
      if (!["export", "onready", "signal"].includes(path.names[0])) continue;
      found.push({ member, decorator, name: path.names[0] });
    }
  }
  return found;
}

function hasClassDecorator(node: ts.ClassLikeDeclaration, gdName: string): boolean {
  return (ts.getDecorators(node) ?? []).some((decorator) => {
    const path = decoratorPath(decorator);
    return path?.root === gdName && path.names[0] === "class";
  });
}

function isSignalTyped(member: ts.PropertyDeclaration, checker: ts.TypeChecker): boolean {
  if (!member.type || !ts.isTypeReferenceNode(member.type)) return false;
  let symbol = checker.getTypeFromTypeNode(member.type).getSymbol();
  if (!symbol) return false;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol.getName() === "Signal" && (symbol.declarations ?? []).some((d) => d.getSourceFile().isDeclarationFile);
}

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

function isScriptClass(node: ts.ClassLikeDeclaration, checker: ts.TypeChecker): boolean {
  return isDefaultExported(node) && extendsGodotClass(node, checker);
}

function scriptClassProblem(node: ts.ClassLikeDeclaration, checker: ts.TypeChecker): string {
  const problems: string[] = [];
  if (!isDefaultExported(node)) problems.push("which is not the default export of its file");
  if (!extendsGodotClass(node, checker)) problems.push("which does not extend a Godot class");
  return problems.join(" and ");
}

// True when the called method is declared by the engine's typings (Object.connect, Signal.connect, ...),
// so a user class with its own `connect` is not judged.
function isEngineMethod(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const symbol = checker.getSymbolAtLocation(call.expression.name);
  return (symbol?.declarations ?? []).some((d) => d.getSourceFile().isDeclarationFile);
}

function rejectNonCallable(arg: ts.Expression, call: ts.CallExpression, checker: ts.TypeChecker): void {
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
function thisUsingFunction(arg: ts.Expression, checker: ts.TypeChecker): boolean {
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
function earlyOnreadyReads(node: ts.ClassLikeDeclaration, names: string[]): ts.PropertyAccessExpression[] {
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

const VALUE_TYPES = new Set([
  "Vector2", "Vector2i", "Vector3", "Vector3i", "Vector4", "Vector4i", "Color", "Rect2", "Rect2i",
  "Transform2D", "Transform3D", "Basis", "Quaternion", "Plane", "AABB", "Projection",
]);

function declaredByEngine(symbol: ts.Symbol | undefined): boolean {
  return (symbol?.declarations ?? []).some((d) => d.getSourceFile().isDeclarationFile);
}

// `node.position.x = 5`: the engine hands out a fresh Vector2 for `position`, so the write is lost.
function mutatedCopy(
  node: ts.Node,
  checker: ts.TypeChecker,
): { target: ts.PropertyAccessExpression; inner: ts.PropertyAccessExpression | ts.CallExpression; typeName: string } | null {
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
  if (!target || !ts.isPropertyAccessExpression(target)) return null;
  const inner = target.expression;
  let engineSymbol: ts.Symbol | undefined;
  if (ts.isPropertyAccessExpression(inner)) engineSymbol = checker.getSymbolAtLocation(inner.name);
  else if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)) {
    engineSymbol = checker.getSymbolAtLocation(inner.expression.name);
  } else return null;
  if (!declaredByEngine(engineSymbol)) return null;
  const typeSymbol = checker.getTypeAtLocation(inner).getSymbol();
  if (!typeSymbol || !VALUE_TYPES.has(typeSymbol.getName()) || !declaredByEngine(typeSymbol)) return null;
  return { target, inner, typeName: typeSymbol.getName() };
}

function isSignalExpression(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  const symbol = checker.getTypeAtLocation(expr).getSymbol();
  return symbol?.getName() === "Signal" && declaredByEngine(symbol);
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
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) || isStringTyped(first, checker)) {
    return node.arguments.length >= 2 ? 1 : null;
  }
  return 0;
}

// `obj.connect(signalName, fn)` with a signal name held in a variable: the callable is argument 1.
function isStringTyped(node: ts.Expression, checker: ts.TypeChecker): boolean {
  const type = checker.getTypeAtLocation(node);
  return (type.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral | ts.TypeFlags.TemplateLiteral)) !== 0;
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
  // `fn.bind(this)` is a function. The program is not strict, so the checker types it any.
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "bind" &&
    hasCallSignature(checker.getTypeAtLocation(node.expression.expression))
  ) {
    return true;
  }
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
  text = text.replace(/_/g, "");
  if (/^0[xXbBoO]/.test(text)) return "int"; // 0x1E is an int; its E is a digit, not an exponent
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

/** `Label`, `Label | null`, `Label<any>` -> "Label". Anything else (unions of classes, arrays, no type): null. */
function declaredClassName(type: ts.TypeNode | undefined): string | null {
  if (!type) return null;
  if (ts.isParenthesizedTypeNode(type)) return declaredClassName(type.type);
  if (ts.isUnionTypeNode(type)) {
    const named = type.types.filter(
      (t) => !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword) && t.kind !== ts.SyntaxKind.UndefinedKeyword,
    );
    return named.length === 1 ? declaredClassName(named[0]) : null;
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) return type.typeName.text;
  return null;
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
