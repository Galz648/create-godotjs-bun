// Build diagnostics for the silent bugs of builtin value types (value-checks.ts): lost write to a copy (265, warning), conversion
// constructors that return garbage (262, error), value type turned into text (267, warning), iterating a Packed array (268, warning).
// A positive case names the exact original file:line:col of each report; the controls must stay SILENT: the safe form, a
// user class of the same name, a non-engine import, an untyped value, a local variable holding the value, a user-declared member.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setEngineClassRoot } from "../engine-classes.ts";
import { resolveRewrites } from "../options.ts";
import { at, check, compile, mustThrowAt, warningsOf } from "./harness.ts";

const F = "/virtual/values.ts";
const HEAD =
  `import { AABB, Basis, Camera3D, CharacterBody3D, Color, Control, Curve3D, GArray, Node, Node2D, Node3D, NodePath, OS, PackedInt32Array, PackedStringArray, PackedVector3Array, Plane, Projection, Quaternion, Rect2, Sprite3D, Transform3D, Vector2, Vector3, Vector4 } from "godot";\n`;

function positions(src: string, head: string, ticket: string): string[] {
  return warningsOf({ [F]: head + src + "\n" }, F)
    .filter((w) => w.includes(`engine ticket ${ticket};`))
    .map((w) => w.split(" ")[0])
    .sort();
}

/** Each needle (optionally `needle@n` for the n-th occurrence) must be reported once, and nothing else. */
function warnsAt(label: string, src: string, ticket: string, needles: string[], head = HEAD): void {
  const full = head + src + "\n";
  const want = needles
    .map((n) => {
      const [needle, nth] = n.split("@");
      return at(F, full, needle, nth ? Number(nth) : 0);
    })
    .sort();
  const got = positions(src, head, ticket);
  check(JSON.stringify(got) === JSON.stringify(want), label, `want=${want.map((w) => w.split(":").slice(1).join(":")).join(" ")} got=${got.map((w) => w.split(":").slice(1).join(":")).join(" ") || "none"}`);
}

function silentWarn(label: string, src: string, ticket: string, head = HEAD): void {
  const got = positions(src, head, ticket);
  check(got.length === 0, label, `reported at ${got.map((w) => w.split(":").slice(1).join(":")).join(" ")}`);
}

// -- 265: lost write to a copy ---------------------------------------------------------------------------------------
warnsAt(
  "lost-write-engine-properties",
  `export class P extends CharacterBody3D {
  f(g: number, delta: number): void {
    this.velocity.y -= g * delta;
    this.rotation.y = 1;
    this.scale.x *= 2;
    this.global_position.x = 3;
    this.transform.origin.x = 4;
    this.basis.x.y = 1;
    this.rotation_degrees.y++;
    --this.position.z;
  }
}
const n = new Node3D();
n.position.z = 1;
n.rotation.y = 2;
(n.get_node("X") as Node3D).rotation.y = 1;
export function g(body: CharacterBody3D, c: Control, s: Node2D) {
  body.velocity.x = 1;
  c.size.x = 4;
  s.global_scale.y = 3;
}`,
  "265",
  [
    "this.velocity.y", "this.rotation.y", "this.scale.x", "this.global_position.x", "this.transform.origin.x", "this.basis.x.y", "this.rotation_degrees.y", "this.position.z",
    "n.position.z", "n.rotation.y", "(n.get_node(\"X\") as Node3D).rotation.y", "body.velocity.x", "c.size.x", "s.global_scale.y",
  ],
);
warnsAt(
  "lost-write-members-of-value-types",
  `const t = new Transform3D();
t.origin.x = 5;
t.basis.x.y = 1;
const box = new AABB();
box.position.x = 9;
box.size.y += 1;
const pl = new Plane(Vector3.UP, 1);
pl.normal.x = 1;
const r = new Rect2();
r.size.x = 2;
const b = new Basis();
b.y.z = 1;
const p = new Projection();
p.w.x = 2;`,
  "265",
  ["t.origin.x", "t.basis.x.y", "box.position.x", "box.size.y", "pl.normal.x", "r.size.x", "b.y.z", "p.w.x"],
);
warnsAt(
  "lost-write-from-const-local-copy",
  `const n = new Node3D();
const xf = n.transform;
xf.origin.x = 1;
xf.basis = new Basis();`,
  "265",
  ["xf.origin.x"],
);
warnsAt("lost-write-getter-call-stand-in", `const n = new Node2D();\nn.get_position().x = 1;`, "265", ["n.get_position().x"]);
warnsAt("lost-write-getter-call-and-member", `const c = new Control();\nc.get_rect().position.x = 1;\nc.get_global_rect().size.y++;`, "265", ["c.get_rect().position.x", "c.get_global_rect().size.y"]);
warnsAt("lost-write-namespace-import", `import * as G from "godot";\nconst n = new G.Node3D();\nn.scale.y = 2;`, "265", ["n.scale.y"], "");
{
  const w = warningsOf({ [F]: `${HEAD}const n = new Node3D();\nn.rotation.y = 2;\n` }, F)[0] ?? "";
  check(w.includes("changes a temporary copy") && w.includes("n.rotation = new Vector3(...)") && w.includes("const v = n.rotation; v.y = ...; n.rotation = v;"), "lost-write-message-names-the-safe-form", w.slice(0, 200));
}
silentWarn(
  "lost-write-control-safe-forms-and-locals",
  `const n = new Node3D();
const v = n.rotation;
v.y = 7;
n.rotation = v;
n.position = new Vector3(1, 2, 3);
n.rotation = new Vector3(0, 1, 0);
const read = n.rotation.y;
const t = new Transform3D();
t.origin = new Vector3(1, 2, 3);
const o = t.origin;
o.x = 5;
t.origin = o;
const arr: Vector3[] = [new Vector3()];
arr[0].x = 1;
let fresh = new Vector3();
fresh.x = 1;
export const k = read;`,
  "265",
);
silentWarn(
  "lost-write-control-user-class-fields",
  `class Holder { pos = new Vector3(); rot: Vector3 = new Vector3(); get g(): Vector3 { return this.pos; } }
const h = new Holder();
h.pos.x = 3;
h.rot.y = 3;
export class MyBody extends CharacterBody3D {
  velocity = new Vector3();
  f() { this.velocity.y = 1; }
}`,
  "265",
);
silentWarn(
  "lost-write-control-user-class-same-name",
  `class Node3D { rotation = { y: 0 }; position = { x: 0 }; }
const n = new Node3D();
n.rotation.y = 1;
n.position.x = 2;
export const k = n;`,
  "265",
  "",
);
silentWarn(
  "lost-write-control-non-engine-import",
  `import { Node3D } from "./other";\nconst n = new Node3D();\nn.rotation.y = 1;\nn.position.x = 1;`,
  "265",
  "",
);
silentWarn("lost-write-control-untyped", `declare const u: any;\nu.rotation.y = 1;\nu.velocity.y -= 1;\nu.get_position().x = 2;`, "265");
silentWarn("lost-write-control-unknown-member", `const n = new Node3D();\n(n as any).whatever.x = 1;\nn.name_of_nothing.x = 1;`, "265");
silentWarn("lost-write-control-scalar-members", `const n = new Node3D();\nn.visible = true;\nconst v = new Vector3();\nv.x = 1;\nv.y += 2;`, "265");
silentWarn("lost-write-control-unresolved-receiver", `declare function make(): any;\nmake().rotation.y = 1;\nexport class Q extends Node { f() { this.position.x = 1; } }`, "265");
{
  const src = `${HEAD}const n = new Node3D();\nn.rotation.y = 2;\n`;
  const off = compile({ [F]: src }, F, { rewrites: { lostWrites: false } }).map?.warnings ?? [];
  check(off.length === 0, "lost-write-switch-off-is-silent");
  const on = compile({ [F]: src }, F).map?.warnings ?? [];
  check(on.length === 1, "lost-write-switch-default-on");
}
{
  // The member table also reads the generated typings (a getter the seed does not know); with no typings the same line is silent.
  const root = mkdtempSync(join(tmpdir(), "zz-values-"));
  mkdirSync(join(root, "typings"));
  writeFileSync(
    join(root, "typings", "godot0.gen.d.ts"),
    [
      "declare module \"godot\" {",
      "    class Node3D<Map extends NodePathMap = any> extends Node<Map> {",
      "        /** doc */",
      "        get weird_vector(): Vector3",
      "        set weird_vector(value: Vector3)",
      "        get_aim(): Vector3",
      "        get_points(index: int64 /* = 0 */): PackedVector3Array",
      "        get plain_number(): float64",
      "    }",
      "    class Camera9D extends Node3D {",
      "        get focus(): Vector3",
      "    }",
      "}",
      "",
    ].join("\n"),
  );
  const body = `import { Node3D, Camera9D } from "godot";\nconst n = new Node3D();\nn.weird_vector.x = 1;\nn.get_aim().y = 2;\nn.plain_number.x = 3;\nconst c = new Camera9D();\nc.focus.z = 1;\nc.weird_vector.z = 1;\nfor (const q of n.get_points()) {}\n`;
  setEngineClassRoot(root);
  const withTypings = warningsOf({ [F]: body }, F).map((w) => w.split(" ")[0]).sort();
  const want = ["n.weird_vector.x", "n.get_aim().y", "c.focus.z", "c.weird_vector.z"].map((s) => at(F, body, s)).concat(at(F, body, "n.get_points()")).sort();
  check(JSON.stringify(withTypings) === JSON.stringify(want), "member-table-reads-generated-typings", withTypings.join(" "));
  setEngineClassRoot(join(tmpdir(), "zz-values-none"));
  const without = warningsOf({ [F]: body }, F);
  check(without.length === 0, "member-table-control-no-typings-is-silent", `${without.length} warnings`);
}

// -- 262: conversion constructors that return garbage --------------------------------------------------------------------
function badFires(label: string, body: string, needle: string, position: string, head = HEAD): void {
  const src = `${head}${body}\n`;
  mustThrowAt({ [F]: src }, F, needle, at(F, src, position), label);
}
function badSilent(label: string, body: string, head = HEAD): void {
  try {
    compile({ [F]: `${head}${body}\n` }, F);
    check(true, label);
  } catch (error) {
    check(false, label, String(error).split("\n")[0].slice(0, 200));
  }
}
badFires("conv-262-quaternion-from-basis", `const b = new Basis();\nexport const q = new Quaternion(b);`, "b.get_rotation_quaternion()", "new Quaternion(b)");
badFires("conv-262-quaternion-from-node-basis", `const n = new Node3D();\nexport const q = new Quaternion(n.basis);`, "returns garbage", "new Quaternion(n.basis)");
badFires("conv-262-quaternion-from-constant", `export const q = new Quaternion(Basis.IDENTITY);`, "engine ticket 262", "new Quaternion(Basis");
badFires("conv-262-quaternion-from-annotated-param", `export function f(x: Basis) { return new Quaternion(x); }`, "x.get_rotation_quaternion()", "new Quaternion(x)");
badFires("conv-262-projection-from-transform", `export function f(t: Transform3D) { return new Projection(t); }`, "new Projection(new Vector4(t.basis.x.x", "new Projection(t)");
badFires("conv-262-transform-from-projection", `export function f(p: Projection) { return new Transform3D(p); }`, "new Transform3D(new Basis(new Vector3(p.x.x", "new Transform3D(p)");
badFires("conv-262-transform-from-projection-constant", `export const t = new Transform3D(Projection.IDENTITY);`, "engine ticket 262", "new Transform3D(Projection");
badFires("conv-262-namespace-import", `import * as G from "godot";\nconst b = new G.Basis();\nexport const q = new G.Quaternion(b);`, "returns garbage", "new G.Quaternion(b)", "");
badSilent("conv-262-control-safe-forms", `const b = new Basis();\nexport const q = b.get_rotation_quaternion();\nexport const r = new Quaternion(0, 0, 0, 1);\nexport const s = new Quaternion(new Vector3(0, 0, 1), 0.5);\nexport const u = new Quaternion(q);`);
badSilent("conv-262-control-other-constructors", `const t = new Transform3D();\nconst p = new Projection();\nexport const a = new Transform3D(t);\nexport const c = new Projection(p);\nexport const d = new Transform3D(new Basis(), new Vector3());\nexport const e = new Transform3D(new Basis());\nexport const f = new Projection(new Vector4(), new Vector4(), new Vector4(), new Vector4());`);
badSilent("conv-262-control-user-class-same-name", `class Basis {}\nclass Quaternion { constructor(public b?: unknown) {} }\nexport const q = new Quaternion(new Basis());`, "");
badSilent("conv-262-control-non-engine-import", `import { Quaternion } from "./other";\nimport { Basis } from "godot";\nexport const q = new Quaternion(new Basis());`, "");
badSilent("conv-262-control-untyped", `declare const x: any;\nexport const q = new Quaternion(x);\nexport const t = new Transform3D(x);`);
badSilent("conv-262-control-unresolved-call", `declare function make(): any;\nexport const q = new Quaternion(make());`);
{
  const src = `${HEAD}const b = new Basis();\nexport const q = new Quaternion(b);\n`;
  let off = true;
  try {
    compile({ [F]: src }, F, { rewrites: { badConversions: false } });
  } catch {
    off = false;
  }
  check(off, "conv-262-switch-off-leaves-the-construct-alone");
}

// -- 267: a value type turned into text ----------------------------------------------------------------------------------
warnsAt(
  "string-267-forms",
  `export function f(v: Vector3, c: Color, path: NodePath, n: Node3D, s: string) {
  const a = \`at \${v}\`;
  const b = String(c);
  const d = "pos " + n.position;
  const e = v + "";
  s += n.rotation;
  const g = JSON.stringify(v);
  const h = JSON.stringify({ pos: n.position, ok: 1 });
  const i = path.toString();
  const j = \`\${path} / \${n.transform}\`;
  return [a, b, d, e, g, h, i, j, s];
}`,
  "267",
  ["v}`", "c);", "n.position;", "v + \"\"", "n.rotation;", "v);\n  const h", "n.position, ok", "path.toString", "path} /", "n.transform}"],
);
warnsAt(
  "string-267-shapes-an-array-and-a-singleton-call",
  `const curve = new Curve3D();
export const t = \`pts \${curve.get_baked_points()}\`;
export const u = JSON.stringify([new Vector3(), 1]);`,
  "267",
  ["curve.get_baked_points()}", "new Vector3(), 1"],
);
silentWarn(
  "string-267-control-safe-forms",
  `import { str } from "godot";
export function f(v: Vector3, n: Node3D, t: string) {
  const a = \`at \${v.x}, \${v.y}\`;
  const b = "pos " + n.position.x;
  const c = str(v);
  const d = String(v.x);
  const e = JSON.stringify({ x: v.x, name: n.name });
  const g = JSON.stringify([1, 2]);
  const h = \`\${t}\${1 + 2}\`;
  console.log(v, n.position);
  const i = \`\${new Vector2(1, 2).x}\`;
  const j = tag\`\${v}\`;
  return [a, b, c, d, e, g, h, i, j, v.toString];
}
declare function tag(s: TemplateStringsArray, ...v: unknown[]): string;`,
  "267",
);
silentWarn(
  "string-267-control-user-class-and-untyped",
  `class Vector3 { toString() { return "mine"; } }\nexport const a = \`\${new Vector3()}\` + String(new Vector3());\ndeclare const u: any;\nexport const b = \`\${u}\` + String(u) + JSON.stringify(u) + ("x" + u);\nexport const c = \`\${new Array<number>()}\` + String([new Date()]);`,
  "267",
  "",
);
silentWarn("string-267-control-non-engine-import", `import { Vector3 } from "./other";\nconst v = new Vector3();\nexport const a = \`\${v}\` + String(v) + JSON.stringify(v);`, "267", "");
silentWarn("string-267-control-numbers-and-strings", `export const a = \`\${1}\` + String(2) + JSON.stringify({ a: 1 }) + ("a" + 2) + (3).toString();`, "267");
{
  const src = `${HEAD}export function f(v: Vector3) { return \`\${v}\`; }\n`;
  const off = compile({ [F]: src }, F, { rewrites: { valueStrings: false } }).map?.warnings ?? [];
  check(off.length === 0, "string-267-switch-off-is-silent");
  check((compile({ [F]: src }, F).map?.warnings ?? []).length === 1, "string-267-switch-default-on");
  const w = (compile({ [F]: src }, F).map?.warnings ?? [])[0] ?? "";
  check(w.includes("str(v)") && w.includes("[object Object]"), "string-267-message-names-the-safe-form", w.slice(0, 220));
}

// -- 268: iterating a Packed*Array --------------------------------------------------------------------------------------
warnsAt(
  "packed-268-forms",
  `export function f(p: PackedVector3Array, q: PackedInt32Array | null, strs: PackedStringArray) {
  for (const x of p) {}
  const a = [...p];
  const b = Array.from(p);
  const c = Array.from(p, (x) => x);
  const [d, e] = p;
  for (const s of OS.get_cmdline_user_args()) {}
  Math.max(...q!);
  for (const s of strs) {}
  return [a, b, c, d, e];
}
const own = new PackedInt32Array();
for (const z of own) {}
const curve = new Curve3D();
for (const pt of curve.get_baked_points()) {}
const ex = Array.from(new PackedStringArray());`,
  "268",
  ["p) {}", "p];", "p);", "p, (x)", "p;\n  for (const s of OS", "OS.get_cmdline_user_args()", "q!", "strs) {}", "own) {}", "curve.get_baked_points()) {}", "new PackedStringArray())"],
);
{
  const src = `${HEAD}export function f(p: PackedVector3Array) { return Array.from(p); }\nexport function g(p: PackedVector3Array) { for (const x of p) {} }\n`;
  const w = warningsOf({ [F]: src }, F);
  check(w.length === 2 && w[0].includes("EMPTY array") && w[1].includes("not iterable") && w[0].includes("Array.from({ length: p.size() }, (_, i) => p.get(i))"), "packed-268-message-names-the-safe-form", (w[0] ?? "").slice(0, 200));
}
silentWarn(
  "packed-268-control-safe-forms",
  `export function f(p: PackedVector3Array, g: GArray, n: Node) {
  const a = Array.from({ length: p.size() }, (_, i) => p.get(i));
  for (let i = 0; i < p.size(); i++) { const x = p.get(i); }
  for (const x of [1, 2]) {}
  const b = Array.from(new Set([1]));
  for (const x of GArray.create([1])) {}
  const c = [...a];
  const [d] = a;
  const e = new PackedVector3Array(a);
  return [a, b, c, d, e, g, n];
}`,
  "268",
);
silentWarn(
  "packed-268-control-user-class-and-untyped",
  `class PackedInt32Array { *[Symbol.iterator]() { yield 1; } }\nexport const a = [...new PackedInt32Array()];\nfor (const x of new PackedInt32Array()) {}\ndeclare const u: any;\nfor (const x of u) {}\nexport const b = Array.from(u);`,
  "268",
  "",
);
silentWarn("packed-268-control-non-engine-import", `import { PackedInt32Array } from "./other";\nfor (const x of new PackedInt32Array()) {}\nexport const a = Array.from(new PackedInt32Array());`, "268", "");
silentWarn("packed-268-control-unresolved-call", `declare function make(): any;\nfor (const x of make()) {}\nexport const a = [...make()];`, "268");
{
  const src = `${HEAD}export function f(p: PackedVector3Array) { return Array.from(p); }\n`;
  check((compile({ [F]: src }, F, { rewrites: { packedIteration: false } }).map?.warnings ?? []).length === 0, "packed-268-switch-off-is-silent");
  check((compile({ [F]: src }, F).map?.warnings ?? []).length === 1, "packed-268-switch-default-on");
}

// -- the switches come from package.json and the environment like every other one (options.ts) ----------------------------
{
  const root = mkdtempSync(join(tmpdir(), "zz-values-opts-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ godotjs: { plugin: { lostWrites: false, packedIteration: false } } }));
  const fromPackage = resolveRewrites(root, {});
  check(!fromPackage.lostWrites && !fromPackage.packedIteration && fromPackage.valueStrings && fromPackage.badConversions, "value-switches-from-package-json");
  const fromEnv = resolveRewrites(root, { GODOTJS_PLUGIN_OFF: "valueStrings,badConversions" });
  check(!fromEnv.valueStrings && !fromEnv.badConversions && !fromEnv.lostWrites, "value-switches-from-env");
  const all = resolveRewrites(root, { GODOTJS_PLUGIN_OFF: "all" });
  check(!all.lostWrites && !all.valueStrings && !all.packedIteration && !all.badConversions, "value-switches-all-off");
}
