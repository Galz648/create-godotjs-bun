# Smoke probe for `bun run export:macos`. NOT part of your game and NOT in the exported app.
# tools/export.ts copies the exported release app to a temp directory, drops an override.cfg next to
# its executable that autoloads this file, runs it headless, and reads the JSON written here.
# The shipped .app and its pack are never modified. Needs GODOTJS_SMOKE_OUT (path of the JSON file).
extends Node

const FRAMES := 15
var _frame := 0

func _process(_delta: float) -> void:
	_frame += 1
	if _frame < FRAMES:
		return
	set_process(false)
	var tree := get_tree()
	var scene := tree.current_scene
	var js_nodes: Array = []
	var js_not_instantiable: Array = []
	if scene != null:
		_walk(scene, js_nodes, js_not_instantiable)
	var report := {
		"frames": _frame,
		"engine": Engine.get_version_info().get("string", ""),
		"debug_build": OS.is_debug_build(),
		"main_scene_loaded": scene != null,
		"main_scene": scene.scene_file_path if scene != null else "",
		"main_scene_script": _script_path(scene) if scene != null else "",
		"node_count": tree.get_node_count(),
		"js_script_nodes": js_nodes,
		"js_scripts_not_instantiable": js_not_instantiable,
	}
	var out := OS.get_environment("GODOTJS_SMOKE_OUT")
	if out != "":
		var f := FileAccess.open(out, FileAccess.WRITE)
		if f != null:
			f.store_string(JSON.stringify(report))
			f.close()
	tree.quit(0)

func _script_path(node: Node) -> String:
	var s: Script = node.get_script()
	return s.resource_path if s != null else ""

func _walk(node: Node, js_nodes: Array, bad: Array) -> void:
	var s: Script = node.get_script()
	if s != null and s.resource_path.ends_with(".ts"):
		js_nodes.append(s.resource_path)
		if not s.can_instantiate():
			bad.append(s.resource_path)
	for c in node.get_children():
		_walk(c, js_nodes, bad)
