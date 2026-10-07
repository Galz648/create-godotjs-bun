// Scene-reader guards the mutation pass found unchecked (tools/mutate.ts, docs/design/mutation-pass.md). Each case names its mutant.
import { Hierarchy, parseTscn, SceneIndex, type SceneFile } from "../scenes.ts";
import { check, compile, gdDecl } from "./harness.ts";

// -- parser (mutants scene-escape, scene-section-reset, scene-resource-or, scene-placeholder)
const escaped = parseTscn(`[node name="A\\"B" type="Label"]\n`);
check(escaped.nodes[0]?.name === 'A"B' && escaped.nodes[0].type === "Label", "guard-tscn-escaped-quote-in-name", escaped.nodes[0]?.name);

const afterSub = parseTscn(`[ext_resource type="Script" path="res://a.ts" id="1"]\n[node name="Root" type="Node"]\n[sub_resource type="Foo" id="x"]\nscript = ExtResource("1")\n`);
check(afterSub.nodes[0].script === undefined, "guard-tscn-property-of-sub-resource-is-not-the-nodes");

const partial = parseTscn(`[ext_resource type="Script" id="5"]\n[ext_resource type="Script" path="res://x.ts"]\n`);
check(partial.resources.size === 0, "guard-tscn-ext-resource-needs-id-and-path", `got=${partial.resources.size}`);

const placeholder = parseTscn(`[node name="Root" type="Node"]\n[node name="P" parent="." instance_placeholder="res://x.tscn"]\n`);
check(placeholder.nodes[1].instance === true, "guard-tscn-instance-placeholder-is-an-instance");

// -- hierarchy (mutant hierarchy-knows-object): Object is the root even when the typings never declare it
const hier = new Hierarchy();
hier.addTypings(`class Foo extends Object {}`);
check(hier.isA("Foo", "Object") === true, "guard-hierarchy-object-is-known-root");

// -- an instanced node's own type is not trusted (mutant scene-instance-type)
hier.addTypings(`class Node extends Object {}\nclass Control extends Node {}\nclass Label extends Control {}\nclass Sprite2D extends Node {}`);
const scene: SceneFile = {
  res: "res://main.tscn",
  scene: parseTscn(`[ext_resource type="Script" path="res://src/a.ts" id="1"]\n[ext_resource type="PackedScene" path="res://sub.tscn" id="2"]\n\n[node name="Root" type="Node"]\nscript = ExtResource("1")\n\n[node name="Sub" type="Label" parent="." instance=ExtResource("2")]\n`),
};
const index = new SceneIndex([scene], hier, (f) => (f === "/virtual/proj/src/a.ts" ? "res://src/a.ts" : null));
const file = "/virtual/proj/src/a.ts";
const src = `import { Node, Sprite2D } from "godot";\n${gdDecl}export default class A extends Node {\n  @gd.onready("Sub")\n  sub!: Sprite2D;\n}\n`;
const warnings = compile({ [file]: src }, file, { scenes: index }).map?.warnings ?? [];
check(warnings.length === 0, "guard-scene-instanced-node-type-not-trusted", warnings[0]);
