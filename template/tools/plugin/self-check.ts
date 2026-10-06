// Build-time checks for the plugin. No Godot process.
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { lookupOriginal, offsetToPos } from "./sourcemap.ts";
import { Hierarchy, parseTscn, SceneIndex, type SceneFile } from "./scenes.ts";
import { transformSourceFile, type TransformOptions } from "./transform.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const GODOT_DTS = join(import.meta.dir, "types/godot.d.ts");
const ANNOT_DTS = join(import.meta.dir, "types/godot.annotations.d.ts");

const fails: string[] = [];
function check(ok: boolean, label: string, detail = ""): void {
  console.log(`${ok ? "OK" : "BAD"} ${label}${detail ? " " + detail : ""}`);
  if (!ok) fails.push(label);
}

function compile(files: Record<string, string>, entry: string, extra: Partial<TransformOptions> = {}): { text: string; map: ReturnType<typeof transformSourceFile> } {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: false,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    lib: ["lib.es2022.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (file) => (file in files ? true : fileExists(file));
  host.readFile = (file) => (file in files ? files[file] : readFile(file));
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map((literal) => {
      let resolved: string | undefined;
      if (literal.text === "godot") resolved = GODOT_DTS;
      else if (literal.text === "godot.annotations") resolved = ANNOT_DTS;
      else if (literal.text.startsWith(".")) {
        const base = resolve(dirname(containingFile), literal.text);
        resolved = [`${base}.ts`, base].find((candidate) => candidate in files || host.fileExists(candidate));
      }
      if (!resolved) return { resolvedModule: undefined };
      return {
        resolvedModule: {
          resolvedFileName: resolved,
          extension: resolved.endsWith(".d.ts") ? ts.Extension.Dts : ts.Extension.Ts,
        },
      };
    });
  const program = ts.createProgram({ rootNames: [entry], options, host });
  const sf = program.getSourceFile(entry);
  if (!sf) throw new Error(`missing source ${entry}`);
  const result = transformSourceFile(sf, program.getTypeChecker(), { gdModule: "/virtual/lib/gd.ts", ...extra });
  return { text: result?.map.generatedText ?? files[entry], map: result };
}

function mustThrow(files: Record<string, string>, entry: string, needle: string, label: string): void {
  try {
    compile(files, entry);
    check(false, label, "did not throw");
  } catch (error) {
    const message = String(error);
    check(message.includes(needle), label, message.split("\n")[0]);
  }
}

const header = `import { IntegerType, Node, Node2D, Resource } from "godot";
import { createClassBinder } from "godot.annotations";
const bind = createClassBinder();
`;

const exportsFile = `/virtual/exports.ts`;
const exportsSrc = `${header}
@bind()
export default class Probe extends Node {
  @bind.export.array(String)
  accessor tags: string[] = [];
  @bind.export.array(Resource)
  accessor items: Resource[] = [];
  @bind.export.array(IntegerType)
  accessor scores: number[] = [];
  @bind.export.object(Resource)
  accessor note: Resource | null = null;
  @bind.export.object(Node)
  accessor marker: Node | null = null;
  @bind.export.object(Node2D)
  accessor sprite: Node2D | null = null;
  @bind.export.array(Node)
  accessor markers: Node[] = [];
}
`;
const exported = compile({ [exportsFile]: exportsSrc }, exportsFile).text;
check(exported.includes("hint: 23, hint_string: \"4:\""), "array-string");
check(exported.includes("hint: 23, hint_string: \"24/17:Resource\""), "array-resource");
check(exported.includes("hint: 23, hint_string: \"2:\""), "array-int");
check(exported.includes("hint: 17, hint_string: \"Resource\""), "object-resource");
check(exported.includes("hint: 34, hint_string: \"Node\""), "object-node");
check(exported.includes("hint: 34, hint_string: \"Node2D\""), "object-node2d");
check(exported.includes("hint: 23, hint_string: \"24/34:Node\""), "array-node");
check(!exported.includes(".array(") && !exported.includes(".object("), "helpers-rewritten");

const personFile = `/virtual/person.ts`;
const personSrc = `${header.replace("IntegerType, ", "")}
@bind()
export default class Person extends Resource {}
`;
const probePerson = `/virtual/probe-person.ts`;
const probePersonSrc = `import { Node } from "godot";
import { createClassBinder } from "godot.annotations";
import Person from "./person";
const bind = createClassBinder();
@bind()
export default class Probe extends Node {
  @bind.export.object(Person)
  accessor person: Person | null = null;
  @bind.export.array(Person)
  accessor people: Person[] = [];
}
`;
const personOut = compile(
  { [personFile]: personSrc, [probePerson]: probePersonSrc },
  probePerson,
).text;
check(personOut.includes("hint: 17, hint_string: \"Person\""), "object-person");
check(personOut.includes("hint: 23, hint_string: \"24/17:Person\""), "array-person");

const anyFile = `/virtual/any.ts`;
mustThrow(
  {
    [anyFile]: `${header}
const Mystery: any = Resource;
@bind()
export default class Probe extends Node {
  @bind.export.object(Mystery)
  accessor note: Resource | null = null;
}
`,
  },
  anyFile,
  "any or unresolved",
  "error-any",
);

const genericFile = `/virtual/generic.ts`;
mustThrow(
  {
    [genericFile]: `${header}
class Box<T> extends Resource {}
@bind()
export default class Probe extends Node {
  @bind.export.object(Box)
  accessor note: Resource | null = null;
}
`,
  },
  genericFile,
  "generic",
  "error-generic",
);

const gdFile = `/virtual/gd.ts`;
const gdSrc = `import { Node, Resource } from "godot";
declare const gd: { export: ((type?: number, hint?: object) => unknown) & { class?: unknown }; class: unknown };
@gd.class
export default class Syntax extends Node {
  @gd.export()
  accessor speed: number = 200.0;
  @gd.export()
  accessor health: number = 100;
  @gd.export()
  accessor tags: string[] = [];
  @gd.export()
  accessor note: Resource | null = null;
  @gd.export()
  accessor marker: Node | null = null;
}
`;
const gdOut = compile({ [gdFile]: gdSrc }, gdFile).text;
check(/gd\.export\(3\)/.test(gdOut) && gdOut.includes("speed"), "gd-float-literal", "200.0");
check(gdOut.includes("gd.export(2)"), "gd-int-literal");
check(gdOut.includes("hint_string: \"4:\""), "gd-string-array");
check(gdOut.includes("hint: 17, hint_string: \"Resource\""), "gd-resource");
check(gdOut.includes("hint: 34, hint_string: \"Node\""), "gd-node");

const numArray = `/virtual/num-array.ts`;
mustThrow(
  {
    [numArray]: `import { Node } from "godot";
declare const gd: { export: () => unknown; class: unknown };
@gd.class
export default class Syntax extends Node {
  @gd.export()
  accessor scores: number[] = [];
}
`,
  },
  numArray,
  "ambiguous",
  "error-number-array",
);

const onreadyFile = `/virtual/onready.ts`;
const onreadySrc = `import { Node } from "godot";
import { createClassBinder } from "godot.annotations";
const bind = createClassBinder();
@bind()
export default class Missing extends Node {
  @bind.onready("Child")
  child!: Node;

  @bind.onready("Missing")
  missing!: Node;

  @bind.onready("Child/Nested")
  nested!: Node;

  @bind.onready((_self: unknown) => {
    throw new Error("onready-boom");
  })
  boom!: Node;

  _ready(): void {
    throw new Error("boom-map");
  }
}
`;
const onready = compile({ [onreadyFile]: onreadySrc }, onreadyFile);
check(!onready.text.includes(".onready("), "onready-stripped");
check(onready.text.includes('get_node("Child")') && onready.text.includes('get_node("Missing")') && onready.text.includes('get_node("Child/Nested")'), "onready-order");
check(onready.text.includes("something wrong when evaluating onready 'boom'"), "onready-warn-text");
const throwIdx = onready.text.indexOf('throw new Error("boom-map")');
const origOff = lookupOriginal(onready.map!.map.ranges, throwIdx);
const origPos = offsetToPos(onready.map!.map.originalStarts, origOff!);
const wantLine = onreadySrc.split("\n").findIndex((line) => line.includes('throw new Error("boom-map")')) + 1;
check(origPos.line === wantLine, "sourcemap-throw-line", `got=${origPos.line} want=${wantLine} col=${origPos.col}`);

const connectFile = `/virtual/connect.ts`;
const connectSrc = `import { Callable, Node, type Signal } from "godot";
import { createClassBinder } from "godot.annotations";
const bind = createClassBinder();
@bind()
export default class Probe extends Node {
  @bind.signal()
  accessor ping!: Signal<(n: number) => void>;
  _ready(): void {
    const fn = (n: number) => n;
    const other = (n: number) => n;
    this.ping.connect(fn);
    this.ping.is_connected(other);
    this.ping.disconnect(fn);
    this.ping.connect(fn, 4);
    this.ping.is_connected(Callable.create(fn));
    const node = new Node();
    this.ping.is_connected(Callable.create(node, fn));
    this.connect("ping", fn);
    this.create_tween().tween_callback(() => {});
  }
  create_tween(): { tween_callback(fn: () => void): void } { return { tween_callback() {} }; }
}
`;
const connectOut = compile({ [connectFile]: connectSrc }, connectFile).text;
check(connectOut.includes("this.ping.connect(Callable.create(fn))"), "connect-wrap");
check(connectOut.includes("this.ping.connect(Callable.create(fn), 4)"), "connect-flags");
check(connectOut.includes("is_connected(Callable.create(other))"), "is-connected-wrap");
check(connectOut.includes("disconnect(Callable.create(fn))"), "disconnect-wrap");
check(connectOut.includes("is_connected(Callable.create(fn))"), "create-not-double");
check(!connectOut.includes("Callable.create(Callable.create"), "no-double-wrap");
check(connectOut.includes("callableWithOwner(node, fn)"), "owner-eq");
check(connectOut.includes('this.connect("ping", Callable.create(fn))'), "object-connect");
check(connectOut.includes("tween_callback(Callable.create(() => {}))"), "tween");
check(!connectOut.includes(".connect(fn)") && !connectOut.includes(".connect(other)"), "no-bare-fn-connect");

// ---------------------------------------------------------------------------------------------
// Automatic class registration, type-only signals, and the build-time diagnostics.
// Every message is checked for its text and for the ORIGINAL file:line:col it points at.
// ---------------------------------------------------------------------------------------------

/** "file:line:col" of the first occurrence of `needle` in `src`. */
function at(file: string, src: string, needle: string, nth = 0): string {
  let index = -1;
  for (let i = 0; i <= nth; i++) index = src.indexOf(needle, index + 1);
  if (index < 0) throw new Error(`self-check bug: ${needle} not in source`);
  const before = src.slice(0, index).split("\n");
  return `${file}:${before.length}:${before[before.length - 1].length + 1}`;
}

function warningsOf(files: Record<string, string>, entry: string): string[] {
  return compile(files, entry).map?.warnings ?? [];
}

function mustThrowAt(files: Record<string, string>, entry: string, needle: string, position: string, label: string): void {
  try {
    compile(files, entry);
    check(false, label, "did not throw");
  } catch (error) {
    const message = String(error);
    check(message.includes(`${position} `) && message.includes(needle), label, message.split("\n")[0]);
  }
}

const gdDecl = `declare const gd: any;\n`;

// -- 1. automatic @gd.class ---------------------------------------------------------------
const autoFile = `/virtual/auto.ts`;
const autoSrc = `import { Node } from "godot";
${gdDecl}export default class Auto extends Node {
  @gd.export()
  accessor health: number = 100;
}
`;
const autoOut = compile({ [autoFile]: autoSrc }, autoFile).text;
check(autoOut.includes("@gd.class export default class Auto"), "auto-class-added");
check((autoOut.match(/gd\.class/g) ?? []).length === 1, "auto-class-once");

const explicitFile = `/virtual/explicit.ts`;
const explicitSrc = `import { Node } from "godot";
${gdDecl}@gd.class
export default class Explicit extends Node {
  @gd.export()
  accessor health: number = 100;
  @gd.signal()
  accessor hit!: Signal<() => void>;
}
`;
const explicitOut = compile({ [explicitFile]: explicitSrc }, explicitFile).text;
check((explicitOut.match(/gd\.class/g) ?? []).length === 1, "explicit-class-no-double");
check((explicitOut.match(/gd\.signal\(\)/g) ?? []).length === 1, "explicit-signal-no-double");

const plainFile = `/virtual/plain.ts`;
const plainSrc = `import { Node } from "godot";
export default class Plain extends Node {
  accessor n: number = 1;
  m = 2;
}
`;
check(compile({ [plainFile]: plainSrc }, plainFile).map === null, "plain-class-untouched");

const namedDefault = `/virtual/named-default.ts`;
const namedDefaultOut = compile(
  {
    [namedDefault]: `import { Node } from "godot";
${gdDecl}class Late extends Node {
  @gd.export()
  accessor health: number = 100;
}
export default Late;
`,
  },
  namedDefault,
).text;
check(namedDefaultOut.includes("@gd.class class Late"), "auto-class-export-default-name");

const inheritFile = `/virtual/inherit.ts`;
const inheritOut = compile(
  {
    [inheritFile]: `import { Node2D } from "godot";
${gdDecl}class Base extends Node2D {}
export default class Derived extends Base {
  @gd.export()
  accessor health: number = 100;
}
`,
  },
  inheritFile,
).text;
check(inheritOut.includes("@gd.class export default class Derived"), "auto-class-via-project-base");

const notDefault = `/virtual/not-default.ts`;
const notDefaultSrc = `import { Node } from "godot";
${gdDecl}export class Helper extends Node {
  @gd.export()
  accessor health: number = 100;
}
export default class Main extends Node {}
`;
mustThrowAt({ [notDefault]: notDefaultSrc }, notDefault, "not the default export", at(notDefault, notDefaultSrc, "@gd.export()"), "error-not-default-export");

const notGodot = `/virtual/not-godot.ts`;
const notGodotSrc = `${gdDecl}export default class Plainly {
  @gd.onready("Label")
  label!: unknown;
}
`;
mustThrowAt({ [notGodot]: notGodotSrc }, notGodot, "does not extend a Godot class", at(notGodot, notGodotSrc, '@gd.onready("Label")'), "error-not-godot-class");

// -- 2. signals declared by type only -----------------------------------------------------
const sigFile = `/virtual/sig.ts`;
const sigSrc = `import { Node, type Signal } from "godot";
export default class Sig extends Node {
  accessor spun!: Signal<(amount: number) => void>;
  accessor done!: Signal<() => void>;
  alias: Signal<() => void> = this.done;
  _ready(): void {
    throw new Error("boom-sig");
  }
}
`;
const sig = compile({ [sigFile]: sigSrc }, sigFile);
check(sig.text.includes("@__gd.signal() accessor spun!") && sig.text.includes("@__gd.signal() accessor done!"), "signal-by-type");
check(!sig.text.includes("@__gd.signal() alias"), "signal-field-with-initializer-left-alone");
check(sig.text.includes('import { gd as __gd } from "/virtual/lib/gd.ts";') && sig.text.includes("@__gd.class export default class Sig"), "signal-injects-gd-import");
const sigIdx = sig.text.indexOf('throw new Error("boom-sig")');
const sigOrig = offsetToPos(sig.map!.map.originalStarts, lookupOriginal(sig.map!.map.ranges, sigIdx)!);
check(sigOrig.line === sigSrc.split("\n").findIndex((l) => l.includes("boom-sig")) + 1, "sourcemap-after-injected-import", `line=${sigOrig.line}`);

const sigGdFile = `/virtual/sig-gd.ts`;
const sigGd = compile(
  {
    [sigGdFile]: `import { Node, type Signal } from "godot";
import { gd } from "./lib/gd";
export default class SigGd extends Node {
  @gd.export()
  accessor n: number = 1;
  accessor spun!: Signal<() => void>;
}
`,
    "/virtual/lib/gd.ts": `export const gd: any = {};\n`,
  },
  sigGdFile,
).text;
check(sigGd.includes("@gd.signal() accessor spun") && !sigGd.includes("__gd"), "signal-uses-imported-gd");

const sigUser = `/virtual/sig-user.ts`;
check(
  compile(
    {
      [sigUser]: `import { Node } from "godot";
interface Signal<T> { x: T }
export default class SigUser extends Node {
  accessor spun!: Signal<number>;
}
`,
    },
    sigUser,
  ).map === null,
  "user-signal-type-is-not-a-signal",
);

const sigNear = `/virtual/sig-near.ts`;
const sigNearSrc = `import { Node, type Signal } from "godot";
export default class SigNear extends Node {
  spun!: Signal<() => void>;
}
`;
mustThrowAt({ [sigNear]: sigNearSrc }, sigNear, "not an `accessor`", at(sigNear, sigNearSrc, "spun!"), "error-signal-not-accessor");

// -- 3. member decorators the engine cannot register --------------------------------------
const plainExport = `/virtual/plain-export.ts`;
const plainExportSrc = `import { Node } from "godot";
${gdDecl}export default class PlainExport extends Node {
  @gd.export()
  plain: number = 5;
}
`;
mustThrowAt({ [plainExport]: plainExportSrc }, plainExport, "needs an instance `accessor` field", at(plainExport, plainExportSrc, "@gd.export()"), "error-export-not-accessor");

const plainSignal = `/virtual/plain-signal.ts`;
const plainSignalSrc = `import { Node, type Signal } from "godot";
${gdDecl}export default class PlainSignal extends Node {
  @gd.signal()
  sig!: Signal<() => void>;
}
`;
mustThrowAt({ [plainSignal]: plainSignalSrc }, plainSignal, "needs an instance `accessor` field", at(plainSignal, plainSignalSrc, "@gd.signal()"), "error-signal-not-accessor");

const staticExport = `/virtual/static-export.ts`;
const staticExportSrc = `import { Node } from "godot";
${gdDecl}export default class StaticExport extends Node {
  @gd.export()
  static accessor shared: number = 5;
}
`;
mustThrowAt({ [staticExport]: staticExportSrc }, staticExport, "needs an instance `accessor` field", at(staticExport, staticExportSrc, "@gd.export()"), "error-export-static");

const onreadyPlain = `/virtual/onready-plain.ts`;
const onreadyPlainSrc = `import { Node } from "godot";
${gdDecl}export default class OnreadyPlain extends Node {
  @gd.onready("Label")
  label!: Node;
  @gd.onready("Other")
  accessor other!: Node;
}
`;
const onreadyPlainOut = compile({ [onreadyPlain]: onreadyPlainSrc }, onreadyPlain).text;
check(onreadyPlainOut.includes('get_node("Label")') && onreadyPlainOut.includes('get_node("Other")'), "onready-plain-field-and-accessor-both-fine");

const onreadyDyn = `/virtual/onready-dyn.ts`;
const onreadyDynSrc = `import { Node } from "godot";
${gdDecl}const path = "Label";
export default class OnreadyDyn extends Node {
  @gd.onready(path)
  label!: Node;
}
`;
mustThrowAt({ [onreadyDyn]: onreadyDynSrc }, onreadyDyn, "string path or a function", at(onreadyDyn, onreadyDynSrc, "path)"), "error-onready-non-literal-path");

const exportNonLiteral = `/virtual/export-nonliteral.ts`;
const exportNonLiteralSrc = `import { Node } from "godot";
${gdDecl}const BASE = 10;
export default class ExportNonLiteral extends Node {
  @gd.export()
  accessor speed: number = BASE * 2;
}
`;
mustThrowAt({ [exportNonLiteral]: exportNonLiteralSrc }, exportNonLiteral, "numeric literal", at(exportNonLiteral, exportNonLiteralSrc, "@gd.export()"), "error-export-non-literal-number");

const hexFile = `/virtual/hex.ts`;
const hexOut = compile(
  {
    [hexFile]: `import { Node } from "godot";
${gdDecl}export default class Hex extends Node {
  @gd.export()
  accessor mask: number = 0x1E;
  @gd.export()
  accessor big: number = 1_000;
  @gd.export()
  accessor ratio: number = 1e3;
  @gd.export()
  accessor half: number = 0.5;
}
`,
  },
  hexFile,
).text;
check(/gd\.export\(2\)\s*\n\s*accessor mask/.test(hexOut), "hex-literal-is-int", "0x1E");
check(/gd\.export\(2\)\s*\n\s*accessor big/.test(hexOut), "separator-literal-is-int", "1_000");
check(/gd\.export\(3\)\s*\n\s*accessor ratio/.test(hexOut), "exponent-literal-is-float", "1e3");
check(/gd\.export\(3\)\s*\n\s*accessor half/.test(hexOut), "decimal-literal-is-float", "0.5");

// -- 4. connect() arguments ---------------------------------------------------------------
const cArgsFile = `/virtual/connect-args.ts`;
const cArgsHeader = `import { Node, type Signal } from "godot";
class Foo {}
`;
const cClassSrc = `${cArgsHeader}export default class C extends Node {
  accessor ping!: Signal<() => void>;
  _ready(): void {
    this.ping.connect(Foo);
  }
}
`;
mustThrowAt({ [cArgsFile]: cClassSrc }, cArgsFile, "not the class `Foo`", at(cArgsFile, cClassSrc, "Foo)"), "error-connect-class");
const cNumSrc = `${cArgsHeader}export default class C extends Node {
  _ready(): void {
    this.connect("ping", 5);
  }
}
`;
mustThrowAt({ [cArgsFile]: cNumSrc }, cArgsFile, "type 5", at(cArgsFile, cNumSrc, "5)"), "error-connect-number");
const cObjSrc = `${cArgsHeader}export default class C extends Node {
  _ready(): void {
    this.connect("ping", { handler: 1 });
  }
}
`;
mustThrowAt({ [cArgsFile]: cObjSrc }, cArgsFile, "takes a function or a Callable", at(cArgsFile, cObjSrc, "{ handler"), "error-connect-object");

const cOkSrc = `import { Node, Callable, type Signal } from "godot";
class Client { connect(host: string): void {} }
export default class C extends Node {
  accessor ping!: Signal<() => void>;
  on(): void {}
  _ready(): void {
    new Client().connect("localhost");
    const nothing: Callable | null = null;
    this.ping.connect(nothing as Callable);
    const name: string = "ping";
    const fn = () => {};
    this.connect(name, fn);
    this.disconnect(name, fn);
    this.is_connected(name, fn);
    this.ping.connect(fn.bind(this));
    this.ping.connect(() => this.on());
  }
}
`;
const cOk = compile({ [cArgsFile]: cOkSrc }, cArgsFile);
check(cOk.text.includes("this.connect(name, Callable.create(fn))"), "connect-string-variable-name-wrapped");
check(cOk.text.includes("this.disconnect(name, Callable.create(fn))") && cOk.text.includes("this.is_connected(name, Callable.create(fn))"), "disconnect-string-variable-name-wrapped");
check(cOk.text.includes("this.ping.connect(Callable.create(fn.bind(this)))"), "connect-bind-is-a-function");
check(cOk.text.includes('new Client().connect("localhost")'), "user-connect-method-untouched");
check((cOk.map?.warnings ?? []).length === 0, "connect-valid-code-no-warning");

// -- 5. `this` in a function handed to connect() ------------------------------------------
const thisFile = `/virtual/this.ts`;
const thisSrc = `import { Node, type Signal } from "godot";
function freeFn(): void { console.log(1); }
function usesThis(this: unknown): void { console.log(this); }
export default class T extends Node {
  accessor ping!: Signal<() => void>;
  value = 1;
  method(): number { return this.value; }
  pure(): number { return 2; }
  _ready(): void {
    this.ping.connect(this.method);
    this.ping.connect(function () { return this.value; });
    this.ping.connect(usesThis);
    this.ping.connect(freeFn);
    this.ping.connect(this.pure);
    this.ping.connect(() => this.method());
    this.ping.connect(this.method.bind(this));
    this.ping.connect(function () { return (() => 1)(); });
  }
}
`;
const thisWarn = warningsOf({ [thisFile]: thisSrc }, thisFile);
check(thisWarn.length === 3, "this-warning-count", `got=${thisWarn.length}`);
const w0 = at(thisFile, thisSrc, "this.method);");
const w1 = at(thisFile, thisSrc, "function () { return this.value");
const w2 = at(thisFile, thisSrc, "usesThis);");
check(thisWarn[0]?.startsWith(w0) && thisWarn[0].includes("`this.method` uses `this`") && thisWarn[0].includes("`this` is undefined"), "this-warning-method", thisWarn[0]?.slice(0, 120));
check(thisWarn[1]?.startsWith(w1) && thisWarn[1].includes("this function uses `this`"), "this-warning-function-expression");
check(thisWarn[2]?.startsWith(w2) && thisWarn[2].includes("`usesThis` uses `this`"), "this-warning-function-declaration");

// -- 6. @onready read before _ready -------------------------------------------------------
const earlyFile = `/virtual/early.ts`;
const earlySrc = `import { Node } from "godot";
${gdDecl}export default class Early extends Node {
  @gd.onready("Label")
  label!: Node;
  early = this.label;
  later = () => this.label;
  constructor() {
    super();
    this.label = null as never;
    console.log(this.label);
  }
  _ready(): void {
    console.log(this.label);
  }
}
`;
const earlyWarn = warningsOf({ [earlyFile]: earlySrc }, earlyFile);
check(earlyWarn.length === 2, "early-onready-count", `got=${earlyWarn.length}`);
check(earlyWarn[0]?.startsWith(at(earlyFile, earlySrc, "this.label;")) && earlyWarn[0].includes("is an @onready field"), "early-onready-initializer");
check(earlyWarn[1]?.startsWith(at(earlyFile, earlySrc, "this.label);")), "early-onready-constructor", earlyWarn[1]?.slice(0, 100));

// -- 7. writes to a copy of an engine value type ------------------------------------------
const copyFile = `/virtual/copy.ts`;
const copySrc = `import { Node2D, Vector2 } from "godot";
class Holder { v = new Vector2(1, 2); }
export default class Copy extends Node2D {
  holder = new Holder();
  _ready(): void {
    this.position.x = 5;
    this.position.y += 1;
    this.position.x++;
    this.modulate.a = 0.5;
    this.get_position().x = 1;
    const p = this.position;
    p.x = 7;
    this.position = p;
    this.holder.v.x = 3;
    this.position = new Vector2(1, 2);
    const read = this.position.x;
    void read;
  }
}
`;
const copyWarn = warningsOf({ [copyFile]: copySrc }, copyFile);
check(copyWarn.length === 5, "copy-warning-count", `got=${copyWarn.length}`);
check(copyWarn[0]?.startsWith(at(copyFile, copySrc, "this.position.x = 5")) && copyWarn[0].includes("changes a temporary copy") && copyWarn[0].includes("new Vector2"), "copy-warning-assign");
check(copyWarn[1]?.startsWith(at(copyFile, copySrc, "this.position.y += 1")), "copy-warning-compound");
check(copyWarn[2]?.startsWith(at(copyFile, copySrc, "this.position.x++")), "copy-warning-increment");
check(copyWarn[3]?.startsWith(at(copyFile, copySrc, "this.modulate.a")) && copyWarn[3].includes("new Color"), "copy-warning-color");
check(copyWarn[4]?.startsWith(at(copyFile, copySrc, "this.get_position().x")), "copy-warning-call");

// -- 8. await on a Signal -----------------------------------------------------------------
const awaitFile = `/virtual/await.ts`;
const awaitSrc = `import { Node, type Signal } from "godot";
export default class A extends Node {
  accessor done!: Signal<() => void>;
  async run(): Promise<void> {
    await this.done;
    await this.done.as_promise();
    await Promise.resolve(1);
  }
}
`;
const awaitWarn = warningsOf({ [awaitFile]: awaitSrc }, awaitFile);
check(awaitWarn.length === 1, "await-signal-count", `got=${awaitWarn.length}`);
check(awaitWarn[0]?.startsWith(at(awaitFile, awaitSrc, "await this.done;")) && awaitWarn[0].includes("as_promise()"), "await-signal-warning");

// -- 9. a generated _ready must not shadow an inherited one -------------------------------------
const superFile = `/virtual/super.ts`;
const superSrc = `import { Node } from "godot";
${gdDecl}class Base extends Node {
  _ready(): void {}
}
export default class NoReady extends Base {
  @gd.onready("Child")
  child!: Node;

  later(): void { throw new Error("boom-super-later"); }
}
`;
const superOut = compile({ [superFile]: superSrc }, superFile);
check(superOut.text.indexOf('get_node("Child")') > 0 && superOut.text.indexOf("super._ready?.();}") > superOut.text.indexOf('get_node("Child")') && (superOut.text.match(/super\._ready/g) ?? []).length === 1, "generated-ready-calls-super-optionally");
const lateIdx = superOut.text.indexOf('throw new Error("boom-super-later")');
const lateOrig = offsetToPos(superOut.map!.map.originalStarts, lookupOriginal(superOut.map!.map.ranges, lateIdx)!);
check(lateOrig.line === superSrc.split("\n").findIndex((l) => l.includes("boom-super-later")) + 1, "sourcemap-after-generated-ready-super", `line=${lateOrig.line}`);
const ownReadyFile = `/virtual/own-ready.ts`;
const ownReadySrc = `import { Node } from "godot";
${gdDecl}class Base extends Node {
  _ready(): void {}
}
export default class OwnReady extends Base {
  @gd.onready("Child")
  child!: Node;

  _ready(): void {
    super._ready();
  }
}
`;
const ownReadyOut = compile({ [ownReadyFile]: ownReadySrc }, ownReadyFile).text;
check((ownReadyOut.match(/super\._ready/g) ?? []).length === 1, "own-ready-super-not-doubled");
check(/_ready\(\): void \{\s*try \{ const __n = this\.get_node\("Child"\)/.test(ownReadyOut), "own-ready-injection-at-start");

// -- 10. @onready paths and types against scenes ------------------------------------------------
const tscn = parseTscn(`[gd_scene load_steps=4 format=3 uid="uid://abc"]

[ext_resource type="Script" uid="uid://x" path="res://src/a.ts" id="1_abc"]
[ext_resource type="PackedScene" path="res://sub.tscn" id="2"]

[node name="Root" type="Node2D" groups=["a", "b c"]]
script = ExtResource("1_abc")
tags = PackedStringArray("x",
"[node name=\\"fake\\" type=\\"Node\\"]")

[node name="Hud" type="Control" parent="."]

[node name="Label" type="Label" parent="Hud"]
text = "[ext_resource path=\\"nope\\"]"

[node name="Sub" parent="." instance=ExtResource("2")]
`);
check(tscn.nodes.length === 4, "tscn-node-count", `got=${tscn.nodes.length}`);
check(tscn.resources.get("1_abc")?.path === "res://src/a.ts" && tscn.resources.get("2")?.type === "PackedScene", "tscn-ext-resources");
check(tscn.nodes[0].script === "1_abc" && tscn.nodes[0].parent === undefined && tscn.nodes[0].type === "Node2D", "tscn-root-script");
check(tscn.nodes[2].parent === "Hud" && tscn.nodes[2].type === "Label" && tscn.nodes[2].script === undefined, "tscn-child");
check(tscn.nodes[3].instance === true && tscn.nodes[3].type === undefined, "tscn-instance-node");

const hier = new Hierarchy();
hier.addTypings(`class Object {}
    class Node<Map extends NodePathMap = any> extends Object implements PathMappable<typeof X.Node, Map> {
    class CanvasItem<Map extends NodePathMap = any> extends Node<Map> {
    class Control<Map extends NodePathMap = any> extends CanvasItem<Map> {
    class Label<Map extends NodePathMap = any> extends Control<Map> {
    class Node2D<Map extends NodePathMap = any> extends CanvasItem<Map> {
    class Sprite2D<Map extends NodePathMap = any> extends Node2D<Map> {
    class Orphan extends NotDeclaredAnywhere {`);
check(hier.isA("Label", "Control") === true && hier.isA("Label", "Node") === true && hier.isA("Label", "Label") === true, "hierarchy-subtype");
check(hier.isA("Node2D", "Control") === false && hier.isA("Control", "Label") === false, "hierarchy-not-subtype");
check(hier.isA("Orphan", "Control") === undefined && hier.isA("Weird", "Control") === undefined && hier.isA("Label", "Weird") === undefined, "hierarchy-unknown-is-undefined");

const sceneProject = "/virtual/proj";
const sceneOf = (res: string, text: string): SceneFile => ({ res, scene: parseTscn(text) });
const rootScene = sceneOf(
  "res://main.tscn",
  `[ext_resource type="Script" path="res://src/a.ts" id="1"]
[ext_resource type="Script" path="res://src/hud.ts" id="2"]
[ext_resource type="PackedScene" path="res://sub.tscn" id="3"]

[node name="Root" type="Node2D"]
script = ExtResource("1")

[node name="Hud" type="Control" parent="."]
script = ExtResource("2")

[node name="Label" type="Label" parent="Hud"]

[node name="Sprite" type="Sprite2D" parent="."]

[node name="Sub" parent="." instance=ExtResource("3")]
`,
);
const otherScene = sceneOf(
  "res://other.tscn",
  `[ext_resource type="Script" path="res://src/a.ts" id="9"]

[node name="Other" type="Node2D"]
script = ExtResource("9")

[node name="Sprite" type="Sprite2D" parent="."]
`,
);
const scenesFor = (...files: SceneFile[]): SceneIndex =>
  new SceneIndex(files, hier, (f) => (f.startsWith(`${sceneProject}/`) ? `res://${f.slice(sceneProject.length + 1)}` : null));
const sceneCompile = (src: string, index: SceneIndex, name = "a"): string[] => {
  const file = `${sceneProject}/src/${name}.ts`;
  return compile({ [file]: src }, file, { scenes: index }).map?.warnings ?? [];
};
const onreadyHead = `import { Node, Node2D, Control, Label, Sprite2D } from "godot";\n${gdDecl}`;

// (a) path missing from every attaching scene: warn at the decorator, name the scene
const missingSrc = `${onreadyHead}export default class A extends Node2D {
  @gd.onready("Hud/Label")
  ok!: Label;

  @gd.onready("Nowhere")
  gone!: Node;
}
`;
const missingWarn = sceneCompile(missingSrc, scenesFor(rootScene));
const missingFile = `${sceneProject}/src/a.ts`;
check(missingWarn.length === 1, "scene-missing-count", `got=${missingWarn.length}`);
check(
  missingWarn[0]?.startsWith(`${at(missingFile, missingSrc, '@gd.onready("Nowhere")')} `) && missingWarn[0].includes("res://main.tscn") && missingWarn[0].includes('"Nowhere"'),
  "scene-missing-warning-position-and-scene",
  missingWarn[0],
);
// path in only one of two attaching scenes: it exists somewhere, so no (a) warning
const partialSrc = `${onreadyHead}export default class A extends Node2D {
  @gd.onready("Hud/Label")
  label!: Label;
}
`;
check(sceneCompile(partialSrc, scenesFor(rootScene, otherScene)).length === 0, "scene-missing-in-one-of-two-silent");
check(sceneCompile(partialSrc, scenesFor(otherScene)).length === 1, "scene-missing-in-the-only-scene-warns");
// script attached to a non-root node: the path is relative to that node
const hudSrc = `${onreadyHead}export default class Hud extends Control {
  @gd.onready("Label")
  label!: Label;

  @gd.onready("Hud")
  wrong!: Node;
}
`;
const hudWarn = sceneCompile(hudSrc, scenesFor(rootScene), "hud");
check(hudWarn.length === 1 && hudWarn[0].includes('"Hud"') && hudWarn[0].includes('node "Hud"'), "scene-relative-to-script-node", hudWarn[0]);
// (b) type mismatch, naming both types
const typeSrc = `${onreadyHead}export default class A extends Node2D {
  @gd.onready("Sprite")
  sprite!: Label;

  @gd.onready("Hud")
  hud!: Control | null;

  @gd.onready("Hud/Label")
  label!: Control;

  @gd.onready("Hud")
  tooGeneral!: Label;
}
`;
const typeWarn = sceneCompile(typeSrc, scenesFor(rootScene));
check(typeWarn.length === 2, "scene-type-count", `got=${typeWarn.length}`);
check(
  typeWarn[0]?.startsWith(`${at(missingFile, typeSrc, '@gd.onready("Sprite")')} `) && typeWarn[0].includes("Label") && typeWarn[0].includes("Sprite2D") && typeWarn[0].includes("res://main.tscn"),
  "scene-type-mismatch-names-both-types",
  typeWarn[0],
);
check(typeWarn[1]?.startsWith(`${at(missingFile, typeSrc, '@gd.onready("Hud")', 1)} `) && typeWarn[1].includes("Control") && typeWarn[1].includes("Label"), "scene-type-supertype-node-for-subtype-field", typeWarn[1]);
// negative: compatible, unknown types, unions, instanced nodes, no type annotation
const fineSrc = `${onreadyHead}declare class Mine extends Node {}
export default class A extends Node2D {
  @gd.onready("Hud/Label")
  a!: Label;
  @gd.onready("Hud/Label")
  b!: Control;
  @gd.onready("Hud/Label")
  c!: Node | null;
  @gd.onready("Hud/Label")
  d!: Mine;
  @gd.onready("Hud/Label")
  e!: Label | Sprite2D;
  @gd.onready("Hud/Label")
  f;
  @gd.onready("Sub")
  g!: Label;
  @gd.onready("Sub/Inner/Deep")
  h!: Label;
  @gd.onready("Sprite")
  i!: Sprite2D;
  @gd.onready(".")
  j!: Node2D;
  @gd.onready("./Hud")
  k!: Control;
}
`;
const fineWarn = sceneCompile(fineSrc, scenesFor(rootScene));
check(fineWarn.length === 0, "scene-correct-code-no-warning", fineWarn.join(" | "));
// skipped silently: unique names, .., absolute, property suffix, expressions
const skipSrc = `${onreadyHead}export default class A extends Node2D {
  @gd.onready("%Unique")
  a!: Label;
  @gd.onready("Hud/../Gone")
  b!: Label;
  @gd.onready("../Sibling")
  c!: Label;
  @gd.onready("/root/Main/Gone")
  d!: Label;
  @gd.onready("Hud:size")
  e!: Label;
  @gd.onready((s: Node2D) => s.get_node("Gone"))
  f!: Label;
  @gd.onready("Hud/%Unique")
  g!: Label;
}
`;
check(sceneCompile(skipSrc, scenesFor(rootScene)).length === 0, "scene-unique-parent-absolute-skipped");
// scripts attached by no scene, and no scenes at all
check(sceneCompile(missingSrc, scenesFor(rootScene), "a").length === 1 && sceneCompile(missingSrc.replace("A extends", "Z extends"), scenesFor(rootScene), "z").length === 0, "scene-script-not-attached-silent");
check(sceneCompile(missingSrc, scenesFor()).length === 0, "scene-no-scenes-silent");
check(compile({ [missingFile]: missingSrc }, missingFile).map?.warnings.length === 0, "scene-no-option-no-warning");
// an inherited scene (root is an instance) cannot prove a path missing
const inheritedScene = sceneOf(
  "res://inh.tscn",
  `[ext_resource type="PackedScene" path="res://base.tscn" id="1"]
[ext_resource type="Script" path="res://src/a.ts" id="2"]

[node name="Inh" instance=ExtResource("1")]
script = ExtResource("2")
`,
);
check(sceneCompile(missingSrc, scenesFor(inheritedScene)).length === 0, "scene-inherited-scene-silent");

// the real project reader: finds scenes, skips nested projects, node_modules and .godot, and a project with no scenes is a no-op
const tmp = mkdtempSync(join(tmpdir(), "tooling-scenes-"));
try {
  mkdirSync(join(tmp, "scenes"), { recursive: true });
  mkdirSync(join(tmp, "nested/scenes"), { recursive: true });
  mkdirSync(join(tmp, "node_modules/x"), { recursive: true });
  mkdirSync(join(tmp, ".godot"), { recursive: true });
  const body = (script: string) => `[ext_resource type="Script" path="res://src/a.ts" id="1"]\n\n[node name="R" type="Node"]\nscript = ExtResource("1")\n`.replace("src/a.ts", script);
  writeFileSync(join(tmp, "scenes/main.tscn"), body("src/a.ts"));
  writeFileSync(join(tmp, "nested/project.godot"), "");
  writeFileSync(join(tmp, "nested/scenes/other.tscn"), body("src/a.ts"));
  writeFileSync(join(tmp, "node_modules/x/n.tscn"), body("src/a.ts"));
  writeFileSync(join(tmp, ".godot/c.tscn"), body("src/a.ts"));
  const real = SceneIndex.fromProject(tmp);
  check(real.sceneCount === 1, "scene-project-reader-scope", `scenes=${real.sceneCount}`);
  const realWarn = real.checkOnready(join(realpathOf(tmp), "src/a.ts"), "Gone", "Node");
  check(realWarn.length === 1 && realWarn[0].includes("res://scenes/main.tscn"), "scene-project-reader-warns", realWarn[0]);
  const empty = mkdtempSync(join(tmpdir(), "tooling-noscenes-"));
  try {
    const none = SceneIndex.fromProject(empty);
    check(none.sceneCount === 0 && none.checkOnready(join(realpathOf(empty), "src/a.ts"), "Gone", "Node").length === 0, "scene-none-is-noop");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
function realpathOf(p: string): string {
  return require("node:fs").realpathSync(p);
}

if (fails.length) {
  console.log(`FAIL self-check ${fails.join(",")}`);
  process.exit(1);
}
console.log("PASS self-check");
