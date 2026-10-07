// Build errors for calls that abort or hang the engine (tickets 80 to 85; abort-checks.ts). Positive cases name the original
// file:line:col, the ticket and the safe form. Controls that must NOT fire: the safe form, a user class named Vector2, a
// non-engine import, an untyped value (any), and the switch off.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setEngineClassRoot } from "../engine-classes.ts";
import { at, check, compile, mustThrowAt } from "./harness.ts";

const F = "/virtual/abort.ts";

function fires(label: string, body: string, needle: string, at_: string, ticket: string, head = `import { Vector2, Vector2i, Vector3, Vector3i, Vector4i, Rect2i, Basis, Quaternion, GArray, PackedInt32Array, PackedByteArray, PackedVector2Array, RefCounted, Geometry2D, AnimationNodeTransition, GridMapEditorPlugin } from "godot";\n`): void {
  const src = `${head}${body}\n`;
  try {
    compile({ [F]: src }, F);
    check(false, label, "did not throw");
  } catch (error) {
    const m = String(error);
    const ok = m.includes(`${at(F, src, at_)} `) && m.includes(`engine ticket ${ticket}`) && m.includes(needle);
    check(ok, label, m.split("\n")[0].slice(0, 160));
  }
}

function silent(label: string, body: string, head = `import { Vector2, Vector2i, Vector3, Rect2i, Basis, GArray, PackedInt32Array, PackedVector2Array, RefCounted, Geometry2D, AnimationNodeTransition } from "godot";\n`): void {
  try {
    compile({ [F]: `${head}${body}\n` }, F);
    check(true, label);
  } catch (error) {
    check(false, label, String(error).split("\n")[0].slice(0, 160));
  }
}

// -- 80: value type from an integer vector / rect ----------------------------------------------
fires("abort-80-vector2-from-vector2i-ctor", `const i = new Vector2i(3, 0);\nexport const v = new Vector2(i);`, "new Vector2(i.x, i.y)", "new Vector2(i)", "80");
fires("abort-80-inline-new", `export const v = new Vector2(new Vector2i(3, 0));`, "aborts the engine", "new Vector2(new", "80");
fires("abort-80-vector2i-copy", `const i = new Vector2i(3, 0);\nexport const v = new Vector2i(i);`, "new Vector2i(i.x, i.y)", "new Vector2i(i)", "80");
fires("abort-80-vector3-from-vector3i", `export function f(p: Vector3i) { return new Vector3(p); }`, "new Vector3(p.x, p.y, p.z)", "new Vector3(p)", "80");
fires("abort-80-rect2-from-rect2i-annotated-param", `import { Rect2 } from "godot";\nexport function f(r: Rect2i) { return new Rect2(r); }`, "new Rect2(r.position.x, r.position.y, r.size.x, r.size.y)", "new Rect2(r)", "80");
fires("abort-80-constant", `export const v = new Vector3(Vector3i.ONE);`, "new Vector3(Vector3i.ONE.x", "new Vector3(Vector3i", "80");
fires("abort-80-vector4i-as-cast", `import { Vector4 } from "godot";\ndeclare const raw: unknown;\nexport const v = new Vector4(raw as Vector4i);`, "aborts the engine", "new Vector4(raw", "80");
fires("abort-80-namespace-import", `import * as G from "godot";\nconst i = new G.Vector2i(1, 2);\nexport const v = new G.Vector2(i);`, "aborts the engine", "new G.Vector2(i)", "80", "");
fires("abort-80-basis-from-quaternion", `const q = new Quaternion();\nexport const b = new Basis(q);`, "Basis.from_euler(q.get_euler())", "new Basis(q)", "80");

silent("abort-80-control-safe-form", `const i = new Vector2i(3, 0);\nexport const v = new Vector2(i.x, i.y);`);
silent("abort-80-control-float-copy", `const a = new Vector2(1, 2);\nexport const v = new Vector2(a);`);
silent("abort-80-control-int-from-float", `const a = new Vector2(1, 2);\nexport const v = new Vector2i(a);`);
silent("abort-80-control-no-args", `export const v = new Vector2(); export const w = new Vector2i(1, 2);`);
silent("abort-80-control-user-class-vector2", `class Vector2 { constructor(public a?: unknown) {} }\nclass Vector2i {}\nexport const v = new Vector2(new Vector2i());`, "");
silent("abort-80-control-user-class-imported-elsewhere", `import { Vector2 as V2 } from "./other";\nimport { Vector2i } from "godot";\nexport const v = new V2(new Vector2i(1, 2));`, `import type {} from "godot";\n`);
silent("abort-80-control-untyped", `declare const x: any;\nexport const v = new Vector2(x);`);
silent("abort-80-control-unknown-expression", `declare function make(): any;\nexport const v = new Vector2(make());\nexport const w = new Vector2(Math.random());`);
silent("abort-80-control-let-reassigned", `let i = new Vector2i(1, 2);\nexport const v = new Vector2(i);`);

// -- 81: new GArray(<PackedXArray>) ------------------------------------------------------------
fires("abort-81-garray-from-packed", `const p = new PackedInt32Array();\nexport const a = new GArray(p);`, "a.push_back(p.get(i))", "new GArray(p)", "81");
fires("abort-81-garray-from-packed-inline", `export const a = new GArray(new PackedByteArray());`, "PackedByteArray", "new GArray(new", "81");
silent("abort-81-control-empty", `export const a = new GArray();`);
silent("abort-81-control-from-garray", `const b = new GArray();\nexport const a = new GArray(b);`);
silent("abort-81-control-create", `export const a = GArray.create([1, 2]);`);

// -- 82: unreference() ---------------------------------------------------------------------------
fires("abort-82-unreference", `const r = new RefCounted();\nr.unreference();`, "weakref()", "r.unreference()", "82");
fires("abort-82-unreference-this", `export class Mine extends RefCounted { f() { this.unreference(); } }`, "Never call reference()", "this.unreference()", "82");
silent("abort-82-control-other-class", `class Pool { unreference() {} }\nexport const p = new Pool();\np.unreference();`);
silent("abort-82-control-untyped", `declare const r: any;\nr.unreference();`);
silent("abort-82-control-has-args", `const r = new RefCounted();\n(r as any).unreference(1);`);
silent("abort-82-control-node", `import { Node } from "godot";\nconst n = new Node();\n(n as any).unreference();`);

// -- 83: AnimationNodeTransition.input_count = negative ------------------------------------------------
fires("abort-83-negative-input-count", `const t = new AnimationNodeTransition();\nt.input_count = -1;`, "never returns", "t.input_count", "83");
silent("abort-83-control-positive", `const t = new AnimationNodeTransition();\nt.input_count = 3;`);
silent("abort-83-control-variable", `const t = new AnimationNodeTransition();\nconst n = -1;\nt.input_count = n;`);
silent("abort-83-control-other-class", `class Box { input_count = 0 }\nconst t = new Box();\nt.input_count = -1;`);

// -- 84: editor-only classes -----------------------------------------------------------------------
fires("abort-84-editor-only-class", `export const p = new GridMapEditorPlugin();`, "only works inside the editor", "new GridMapEditorPlugin", "84");
silent("abort-84-control-user-class", `class GridMapEditorPlugin {}\nexport const p = new GridMapEditorPlugin();`, "");

// -- 85: Geometry2D.offset_polyline of an empty polyline -----------------------------------------------
fires("abort-85-empty-polyline", `export const r = Geometry2D.offset_polyline(new PackedVector2Array(), 10, 1, 4);`, "if (points.size() > 0)", "Geometry2D.offset_polyline", "85");
silent("abort-85-control-filled-variable-and-literal", `const line = new PackedVector2Array();\nline.push_back(new Vector2(0, 0));\nexport const r = Geometry2D.offset_polyline(line, 10, 1, 4);\nexport const s = Geometry2D.offset_polyline(new PackedVector2Array([new Vector2(1, 1)]), 10, 1, 4);`);
silent("abort-85-control-user-class", `class Geometry2D { static offset_polyline(a: unknown, ...r: number[]) { return a; } }\nexport const r = Geometry2D.offset_polyline(new PackedVector2Array(), 10, 1, 4);`, `import { PackedVector2Array } from "godot";\n`);

// -- hierarchy-aware (generated typings present): a subclass of RefCounted / AnimationNodeTransition -----------------------
{
  const root = mkdtempSync(join(tmpdir(), "zz-abort-"));
  mkdirSync(join(root, "typings"));
  writeFileSync(join(root, "typings", "godot.gen.d.ts"), "class Resource extends RefCounted {}\nclass RefCounted extends Object {}\nclass AnimationNodeBlendTree extends AnimationRootNode {}\nclass AnimationRootNode extends Resource {}\nclass SpecialTransition extends AnimationNodeTransition {}\nclass AnimationNodeTransition extends AnimationRootNode {}\n");
  setEngineClassRoot(root);
  fires("abort-82-subclass-with-generated-typings", `import { Resource } from "godot";\nconst r = new Resource();\nr.unreference();`, "script-held Resource", "r.unreference()", "82", "");
  fires("abort-83-subclass-with-generated-typings", `import { SpecialTransition } from "godot";\nconst t = new SpecialTransition();\nt.input_count = -2;`, "negative input_count", "t.input_count", "83", "");
  silent("abort-82-control-node-with-generated-typings", `import { Node } from "godot";\nconst n = new Node();\n(n as any).unreference();`, "");
  setEngineClassRoot(join(tmpdir(), "zz-abort-none"));
}

// -- the switch -----------------------------------------------------------------------------------------------
{
  const src = `import { Vector2, Vector2i } from "godot";\nexport const v = new Vector2(new Vector2i(1, 2));\n`;
  let off = true;
  try {
    compile({ [F]: src }, F, { rewrites: { abortGuards: false } });
  } catch {
    off = false;
  }
  check(off, "abort-switch-off-leaves-the-construct-alone");
  mustThrowAt({ [F]: src }, F, "engine ticket 80", at(F, src, "new Vector2("), "abort-switch-default-on");
}
