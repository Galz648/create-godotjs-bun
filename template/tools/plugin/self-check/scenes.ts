// @onready paths and types against scenes.
import { join } from "node:path";
import ts from "typescript";
import { Hierarchy, parseTscn, SceneIndex, type SceneFile } from "../scenes.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { check, compile, at, gdDecl } from "./harness.ts";

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
