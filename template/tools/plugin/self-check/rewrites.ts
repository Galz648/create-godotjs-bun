// ADR 0009 points 4 and 5: every rewrite has an off switch and an explicit form that does the same thing.
// For each rewrite: (1) the sugar source compiled with everything on, and (2) the explicit source compiled with that
// ONE switch off, must emit the same JS. (3) A deliberately different explicit source must NOT compare equal, so the
// comparison cannot pass vacuously. (4) With the switch off, the sugar source fails the build with a message that
// names the explicit form (or, for `stored`, compiles to unchanged text because the engine accepts it).
// Table of rewrites: docs/PLUGIN-REWRITES.md.
//
// How "same JS" is compared. `compile` returns the transformed TypeScript text, which is what Bun then emits.
// Source-map offsets are not part of that text. Comparison squashes layout only: runs of whitespace become one
// space and spaces next to `{ } ( ) , ;` are dropped (the plugin glues generated text on without indenting it).
// Comments are not stripped (none are generated), and every token and string is compared exactly.
import { REWRITE_NAMES, resolveRewrites, type PluginRewrites } from "../options.ts";
import { check, compile } from "./harness.ts";

const gdStub = { "/virtual/lib/gd.ts": `export const gd: any = {};\n` };

function squash(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/ ?([{}(),;]) ?/g, "$1")
    .trim();
}

type Files = Record<string, string>;
const one = (entry: string, src: string): Files => ({ [entry]: src, ...gdStub });

/** The sugar form with all rewrites on, as squashed text. */
function sugarOut(entry: string, src: string): string {
  return squash(compile(one(entry, src), entry).text);
}
/** An explicit source with only `off` switched off, as squashed text. */
function explicitOut(entry: string, src: string, off: keyof PluginRewrites): string {
  return squash(compile(one(entry, src), entry, { rewrites: { [off]: false } }).text);
}

function equivalence(name: string, off: keyof PluginRewrites, entry: string, sugar: string, explicit: string, wrong: string): void {
  const want = sugarOut(entry, sugar);
  check(want !== squash(sugar), `${name}-sugar-actually-rewritten`);
  check(explicitOut(entry, explicit, off) === want, `${name}-explicit-equals-sugar`, `switch ${off} off`);
  // negative control: a different explicit form compiles fine but does not match
  const other = explicitOut(entry, wrong, off);
  check(other !== want, `${name}-negative-control-differs`);
}

/** With `off` switched off the sugar source must fail the build, and the message must contain `needle`. */
function offThrows(name: string, off: keyof PluginRewrites, entry: string, src: string, needle: string): void {
  try {
    compile(one(entry, src), entry, { rewrites: { [off]: false } });
    check(false, `${name}-off-diagnoses`, "did not throw");
  } catch (error) {
    const message = String(error);
    check(message.includes(needle), `${name}-off-diagnoses`, message.split("\n")[0]);
  }
}

const head = `import { Label, Node } from "godot";
import { gd } from "./lib/gd";
`;

// -- exports: typed @gd.export() ---------------------------------------------------------------
{
  const f = "/virtual/rw-exports.ts";
  const body = (a: string, b: string) => `${head}export default class ExpProbe extends Node {
  ${a}
  accessor hp: number = 10;
  ${b}
  accessor target: Node | null = null;
}
`;
  const sugar = body("@gd.export()", "@gd.export()");
  const explicit = body(
    '@gd.export(2, undefined, undefined, "ExpProbe.hp")',
    '@gd.export(24, { hint: 34, hint_string: "Node" }, undefined, "ExpProbe.target")',
  );
  const wrong = body(
    '@gd.export(3, undefined, undefined, "ExpProbe.hp")', // float where the type says int
    '@gd.export(24, { hint: 34, hint_string: "Node" }, undefined, "ExpProbe.target")',
  );
  equivalence("exports", "exports", f, sugar, explicit, wrong);
  offThrows("exports", "exports", f, sugar, '@gd.export(2, undefined, undefined, "ExpProbe.hp")');

  const g = "/virtual/rw-exports-helper.ts";
  const helperHead = `import { Node } from "godot";
import { createClassBinder } from "godot.annotations";
const bind = createClassBinder();
`;
  const helper = (dec: string) => `${helperHead}@bind()
export default class ExpHelper extends Node {
  ${dec}
  accessor tags: string[] = [];
}
`;
  equivalence(
    "exports-helper",
    "exports",
    g,
    helper("@bind.export.array(String)"),
    helper('@bind.export(28, { hint: 23, hint_string: "4:" })'),
    helper('@bind.export(28, { hint: 23, hint_string: "2:" })'),
  );
  offThrows("exports-helper", "exports", g, helper("@bind.export.array(String)"), 'bind.export(28, { hint: 23, hint_string: "4:" })');
}

// -- onready: generated _ready -----------------------------------------------------------------
{
  const f = "/virtual/rw-onready.ts";
  const sugar = `${head}export default class RdyProbe extends Node {
  @gd.onready("Label")
  label: Label | null = null;
}
`;
  const ready = (assign: string) => `${head}@gd.class
export default class RdyProbe extends Node {
  label: Label | null = null;
  _ready(): void {
    ${assign}
    super._ready?.();
  }
}
`;
  const full = 'try { const __n = this.get_node("Label"); this.label = __n == null ? null : __n; } catch { this.label = null; }';
  equivalence("onready", "onready", f, sugar, ready(full), ready('this.label = this.get_node("Label") as Label;'));
  offThrows("onready", "onready", f, sugar, "`onready` rewrite");

  // the same, inside a _ready the class already has: the generated lines go first
  const g = "/virtual/rw-onready-own.ts";
  const ownSugar = `${head}export default class RdyOwn extends Node {
  @gd.onready("Label")
  label: Label | null = null;
  _ready(): void {
    console.log("mine");
  }
}
`;
  const ownExplicit = `${head}@gd.class
export default class RdyOwn extends Node {
  label: Label | null = null;
  _ready(): void {
    ${full}
    console.log("mine");
  }
}
`;
  const ownWrong = ownExplicit.replace(`${full}\n    console.log("mine");`, `console.log("mine");\n    ${full}`);
  equivalence("onready-own-ready", "onready", g, ownSugar, ownExplicit, ownWrong);
}

// -- register: @gd.class and @gd.signal() ------------------------------------------------------
{
  const f = "/virtual/rw-register.ts";
  const src = (cls: string, sig: string, type = "() => void") => `import { Node, type Signal } from "godot";
import { gd } from "./lib/gd";
${cls}export default class RegProbe extends Node {
  @gd.export(2, undefined, undefined, "RegProbe.hp")
  accessor hp: number = 1;
  ${sig}accessor hit!: Signal<${type}>;
}
`;
  const sugar = src("", "");
  const explicit = src("@gd.class\n", "@gd.signal() ");
  const wrong = src("@gd.class\n", "@gd.signal() ", "(n: number) => void");
  equivalence("register", "register", f, sugar, explicit, wrong);
  offThrows("register-signal", "register", f, sugar, "@gd.signal() accessor hit!");
  offThrows("register-class", "register", f, src("", "@gd.signal() "), "`@gd.class` above the class");
}

// -- stored: @gd.stored on plain accessors -----------------------------------------------------
{
  const f = "/virtual/rw-stored.ts";
  const src = (dec: string) => `${head}export default class StProbe extends Node {
  ${dec}accessor count = 0;
}
`;
  equivalence("stored", "stored", f, src(""), src('@gd.stored("StProbe.count") '), src('@gd.stored("StProbe.cnt") '));
  // the engine accepts the plain accessor, so off needs no diagnostic: the text passes through unchanged
  const text = compile(one(f, src("")), f, { rewrites: { stored: false } }).text;
  check(text === src(""), "stored-off-leaves-source-unchanged");
}

// -- connect: Callable.create(fn) wrapping -----------------------------------------------------
{
  const f = "/virtual/rw-connect.ts";
  const src = (wrapped: boolean, owner: boolean, tweak = "") => `${owner ? 'import { callableWithOwner } from "godotjs-tooling/callable";\n' : ""}import { Callable, Node } from "godot";
export default class CnProbe extends Node {
  _ready(): void {
    const fn = (n: number) => n;
    this.connect("ping", ${wrapped ? "Callable.create(fn)" : "fn"}${tweak});
    ${owner ? "callableWithOwner(this, fn)" : "Callable.create(this, fn)"};
  }
}
`;
  const sugar = src(false, false);
  const explicit = src(true, true);
  const wrong = src(true, true, ", 4"); // an extra argument: a different call
  equivalence("connect", "connect", f, sugar, explicit, wrong);
  check(compile(one(f, explicit), f, { rewrites: { connect: false } }).text === explicit, "connect-off-leaves-explicit-source-unchanged");
  offThrows("connect", "connect", f, sugar, "connect(Callable.create(...))");
  offThrows("connect-owner", "connect", f, src(true, false), "callableWithOwner(owner, fn)");
}

// -- the switches themselves -------------------------------------------------------------------
{
  const none = "/virtual/no-such-project";
  const allOn = resolveRewrites(none, {});
  check(REWRITE_NAMES.every((n) => allOn[n] === true), "switches-default-on");
  const some = resolveRewrites(none, { GODOTJS_PLUGIN_OFF: "exports, connect" });
  check(!some.exports && !some.connect && some.onready && some.register && some.stored, "switches-env-list");
  check(!resolveRewrites(none, { GODOTJS_NO_STORED: "1" }).stored, "switches-no-stored-alias");
  check(REWRITE_NAMES.every((n) => resolveRewrites(none, { GODOTJS_PLUGIN_OFF: "all" })[n] === false), "switches-all");
  let message = "";
  try {
    resolveRewrites(none, { GODOTJS_PLUGIN_OFF: "export" });
  } catch (error) {
    message = String(error);
  }
  check(message.includes('"export" is not a plugin switch'), "switches-typo-is-an-error", message.split("\n")[0]);
}
