// Build-time diagnostics: each message is checked for its text and the ORIGINAL file:line:col.
import { resolve } from "node:path";
import ts from "typescript";
import { lookupOriginal, offsetToPos } from "../sourcemap.ts";
import { check, compile, at, warningsOf, mustThrowAt, gdDecl } from "./harness.ts";

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
check(/gd\.export\(2[^)]*\)\s*\n\s*accessor mask/.test(hexOut), "hex-literal-is-int", "0x1E");
check(/gd\.export\(2[^)]*\)\s*\n\s*accessor big/.test(hexOut), "separator-literal-is-int", "1_000");
check(/gd\.export\(3[^)]*\)\s*\n\s*accessor ratio/.test(hexOut), "exponent-literal-is-float", "1e3");
check(/gd\.export\(3[^)]*\)\s*\n\s*accessor half/.test(hexOut), "decimal-literal-is-float", "0.5");

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
