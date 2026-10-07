// Guards the mutation pass found unchecked (tools/mutate.ts, docs/design/mutation-pass.md). Each case names the mutant it kills.
// The mutant is the negative control: with that one edit applied to the plugin, the case goes BAD (tools/mutate.ts proves it).
import { check, compile, mustThrow, warningsOf, gdDecl } from "./harness.ts";

/** Transformed text, or "THROWS: <first line>" so a wrongly raised build error is a BAD check, not a crash. */
function out(files: Record<string, string>, entry: string): string {
  try {
    return compile(files, entry).text;
  } catch (error) {
    return `THROWS: ${String(error).split("\n")[0]}`;
  }
}
const head = `import { Node, Callable, GArray, Vector2, Vector3, Color, type Signal } from "godot";\n${gdDecl}`;
const ping = `accessor ping!: Signal<() => void>;`;

// -- set_script: only a .gd argument is silent (mutants setscript-warning, setscript-quote)
{
  const f = "/virtual/g-setscript.ts";
  const w = warningsOf({ [f]: `import { Node, Resource } from "godot";\ndeclare const n: Node;\ndeclare const r: Resource;\nn.set_script(r);\nn.set_script(ResourceLoader.load("res://a.gd"));\nn.set_script(ResourceLoader.load('res://b.gd'));\n` }, f);
  check(w.length === 1 && w[0].includes("set_script()"), "guard-set-script-warns-only-for-non-gd", `got=${w.length}`);
}

// -- Callable.create(owner, x) (mutants create-string-template, create-not-function)
{
  const f = "/virtual/g-create.ts";
  const body = (arg: string) => `${head}declare const n: number;\nexport default class A extends Node { _ready(): void { Callable.create(this, ${arg}); } }\n`;
  const named = out({ [f]: body("`handler`") }, f);
  check(!named.startsWith("THROWS") && !named.includes("callableWithOwner"), "guard-create-template-literal-name-left-alone", named.split("\n")[0]);
  mustThrow({ [f]: body("n") }, f, "cannot see a function here", "guard-create-non-function-fails");
}

// -- connect(...) arguments (mutants callable-factory-skip, this-engine-only, callable-import-flag, any-type-fail, engine-method-every, noncallable-nullish)
{
  const f = "/virtual/g-connect.ts";
  const cls = (extra: string, call: string) => `import { Node, type Signal } from "godot";\n${extra}export default class A extends Node {\n  ${ping}\n  _ready(): void { ${call} }\n}\n`;
  const factory = out({ [f]: cls("declare const H: { create(...a: unknown[]): any };\n", "this.ping.connect(H.create(1));") }, f);
  check(!factory.startsWith("THROWS") && !factory.includes("Callable.create(H.create"), "guard-connect-factory-result-not-judged-or-wrapped", factory.split("\n")[0]);

  const userConnect = compile({ [f]: cls("class Client { connect(fn: () => void): void {} }\n", "new Client().connect(function () { return this; });") }, f);
  check((userConnect.map?.warnings.length ?? 0) === 0, "guard-this-warning-only-for-engine-connect", userConnect.map?.warnings[0]);

  const wrapped = out({ [f]: cls("", "this.ping.connect(() => 1);") }, f);
  check(/import \{[^}]*\bCallable\b[^}]*\} from "godot"/.test(wrapped), "guard-connect-adds-callable-import", wrapped.split("\n")[0]);

  mustThrow({ [f]: cls("declare const f: any;\n", "this.ping.connect(f);") }, f, "cannot tell whether", "guard-connect-any-fails-with-explanation");

  const unknownReceiver = out({ [f]: cls("declare const u: any;\n", "u.connect(5);") }, f);
  check(!unknownReceiver.startsWith("THROWS"), "guard-connect-on-unresolved-receiver-not-judged", unknownReceiver.split("\n")[0]);

  const unknownArg = out({ [f]: cls("declare const u: unknown;\n", "this.ping.connect(u);") }, f);
  check(!unknownArg.startsWith("THROWS"), "guard-connect-unknown-typed-arg-silent", unknownArg.split("\n")[0]);
}

// -- this inside a nested function or class belongs to that one (mutant this-nested)
{
  const f = "/virtual/g-this-nested.ts";
  const cls = (fn: string) => `import { Node, type Signal } from "godot";\nexport default class A extends Node {\n  ${ping}\n  _ready(): void { this.ping.connect(${fn}); }\n}\n`;
  const nested = warningsOf({ [f]: cls("function () { const inner = function () { return this; }; class K { m() { return this; } } return inner; }") }, f);
  check(nested.length === 0, "guard-this-in-nested-function-or-class-not-reported", nested[0]);
  const arrow = warningsOf({ [f]: cls("function () { const inner = () => this; return inner; }") }, f);
  check(arrow.length === 1, "guard-this-in-nested-arrow-is-reported", `got=${arrow.length}`);
}

// -- Signal fields (mutants signal-static, gd-local-alias)
{
  const f = "/virtual/g-signal-static.ts";
  const text = out({ [f]: `import { Node, type Signal } from "godot";\nexport default class A extends Node { static shared: Signal<() => void>; }\n` }, f);
  check(!text.startsWith("THROWS"), "guard-static-signal-field-left-alone", text.split("\n")[0]);
  const g = "/virtual/g-gd-alias.ts";
  const aliased = out({ [g]: `import { Node, type Signal } from "godot";\nimport { gd as g } from "./lib/gd";\nexport default class A extends Node { ${ping} }\n`, "/virtual/lib/gd.ts": `export const gd: any = {};\n` }, g);
  check(aliased.includes("@g.signal()") && !aliased.includes("__gd"), "guard-gd-import-alias-is-used", aliased.split("\n")[0]);
}

// -- @stored key of an unnamed class, @gd.class of another namespace (mutants stored-owner-file, class-decorator-root)
{
  const f = "/virtual/anon-stored.ts";
  const anon = out({ [f]: `import { Node } from "godot";\nexport default class extends Node { accessor n = 1; }\n` }, f);
  check(anon.includes('stored("anon-stored.n")'), "guard-stored-key-of-unnamed-class-is-file-name", anon.split("\n")[0]);
  const g = "/virtual/g-class-root.ts";
  const other = out({ [g]: `${head}declare const other: any;\n@other.class\nexport default class K extends Node { @gd.export() accessor hp: number = 1; }\n` }, g);
  check(other.includes("@gd.class"), "guard-foreign-class-decorator-does-not-count", other.split("\n")[0]);
}

// -- GArray.filter wraps, a JS array's filter does not (mutant garray-receiver)
{
  const f = "/virtual/g-garray.ts";
  const text = out({ [f]: `import { GArray } from "godot";\ndeclare const xs: number[];\nxs.filter((x) => x > 1);\nxs.map((x) => x);\nGArray.create([1]).filter((v) => true);\n` }, f);
  check(text.split("Callable.create(").length - 1 === 1, "guard-only-garray-filter-is-wrapped", text.split("Callable.create(").length - 1 + " wraps");
}

// -- export type ids (mutants type-vector3, and the neighbouring constants)
{
  const f = "/virtual/g-type-ids.ts";
  const text = out({ [f]: `${head}export default class T extends Node {
  @gd.export() accessor b: boolean = true;
  @gd.export() accessor i: number = 5;
  @gd.export() accessor f: number = 5.5;
  @gd.export() accessor s: string = "";
  @gd.export() accessor v2: Vector2 = new Vector2();
  @gd.export() accessor v3: Vector3 = new Vector3();
  @gd.export() accessor c: Color = new Color();
}
` }, f);
  const ids: [string, number][] = [["b", 1], ["i", 2], ["f", 3], ["s", 4], ["v2", 5], ["v3", 9], ["c", 20]];
  for (const [name, id] of ids) check(text.includes(`export(${id}, undefined, undefined, "T.${name}")`), `guard-export-type-id-${name}`, `want ${id}`);
}

// -- export validation (mutants export-object-builtin, type-parameter, export-union)
{
  const f = "/virtual/g-export-validation.ts";
  mustThrow({ [f]: `import { Node } from "godot";\nimport { createClassBinder } from "godot.annotations";\nconst bind = createClassBinder();\n@bind()\nexport default class A extends Node { @bind.export.object(String) accessor s: string = ""; }\n` }, f, "does not take", "guard-export-object-rejects-builtin");
  mustThrow({ [f]: `${head}export default class Box<T> extends Node { @gd.export() accessor items: T[] = []; }\n` }, f, "is a type parameter", "guard-export-type-parameter-rejected");
  mustThrow({ [f]: `${head}export default class A extends Node { @gd.export() accessor v: string | number = "a"; }\n` }, f, "split a union", "guard-export-union-rejected");
}

// -- @onready function form gets the node as its argument (mutant onready-call-args)
{
  const f = "/virtual/g-onready-args.ts";
  const text = out({ [f]: `${head}export default class A extends Node { @gd.onready((root: Node) => root.get_node("L")) label!: Node; }\n` }, f);
  check(text.includes(").call(this, this);"), "guard-onready-function-called-with-this-and-self", text.split("\n")[0]);
}

// -- only the default export is a script class (mutant default-export-equals)
{
  const f = "/virtual/g-export-equals.ts";
  mustThrow({ [f]: `${head}class K extends Node { @gd.export() accessor a: number = 1; }\nexport = K;\n` }, f, "not the default export", "guard-export-equals-is-not-default-export");
}

// -- early @onready read: a compound assignment reads (mutant early-write)
{
  const f = "/virtual/g-early-write.ts";
  const w = warningsOf({ [f]: `${head}export default class A extends Node {\n  @gd.onready("Label")\n  label!: Node;\n  constructor() { super(); this.label = null; this.label += 1; }\n}\n` }, f);
  check(w.length === 1 && w[0].includes("this.label"), "guard-early-onready-compound-assignment-is-a-read", `got=${w.length}`);
}

// -- temporary-copy warning (mutants copy-decrement, copy-user-type, signal-expression-engine)
{
  const f = "/virtual/g-copy-decrement.ts";
  const w = warningsOf({ [f]: `import { Node2D } from "godot";\nexport default class A extends Node2D { _ready(): void { this.position.x--; --this.position.y; } }\n` }, f);
  check(w.length === 2, "guard-copy-warning-for-decrements", `got=${w.length}`);
  const user = "/virtual/g-copy-user.ts";
  const files = (from: string) => ({
    [user]: `import { Thing } from "./g-ext.d";\ndeclare const t: Thing;\nt.pos.x = 5;\n`,
    "/virtual/g-ext.d.ts": `import { Vector2 } from "${from}";\nexport class Thing { pos: Vector2; }\n`,
    "/virtual/g-mine.ts": `export class Vector2 { x: number; }\n`,
  });
  check(warningsOf(files("godot"), user).length === 1, "guard-copy-warning-for-engine-value-type");
  check(warningsOf(files("./g-mine"), user).length === 0, "guard-copy-warning-not-for-user-class-named-like-one");
  const s = "/virtual/g-await-user-signal.ts";
  check(warningsOf({ [s]: `class Signal { emit(): void {} }\nexport async function f(sig: Signal) { await sig; }\n` }, s).length === 0, "guard-await-warning-not-for-user-class-named-signal");
}
