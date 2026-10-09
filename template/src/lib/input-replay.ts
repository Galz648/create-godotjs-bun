// Input record and replay: write every input event the game window receives to a file, and feed a recording back at the same
// frames, so a play session (yours, or a scripted bot's) becomes a regression test: replay it with --fixed-fps and compare what the
// game does. Opt-in; Effect not required; not a toolchain file (tools/update.ts never touches it).
//
//   import { inputReplay } from "./lib/input-replay";
//   _ready(): void { inputReplay(this); }   // acts on `-- --record[=path]` / `-- --replay=path`; does nothing without them
//
//   godot --path . -- --record                                       play; the session goes to user://input.replay
//   godot --headless --fixed-fps 60 --path . -- --replay=user://input.replay
//   startInputReplay(node, "record" | "replay", path)                the same without the command line
//
// File: a comment line, then one event per line, `<frame>\t<var_to_str(event)>` (any InputEvent: keys, actions, mouse, joypad).
// <frame> is the number of `_process` calls the recorder node had made when the event arrived; a replay feeds it with
// Input.parse_input_event during that `_process` call (frame N-1's, counting from 1), and the engine delivers it at the start of
// the next frame, before physics and `_process`: the same point as the original. Events reach the recorder through the window's
// `window_input` signal, before any `_input` handler can mark them handled. Equal frames need equal deltas: replay with
// `--fixed-fps` (a wall-clock replay feeds the same events at the same frame numbers, but frames then last differently).
//
// The per-event work is GDScript (INPUT_REPLAY_GD, built at run time): no InputEvent crosses into JS. A JS `_input` handler keeps
// one engine object per event alive until exit (tickets 231 and 270), so a recorder written as one would add a leak to every game
// that has no input handler of its own; this one adds none (starter/tests/input-replay measures it). examples/_kit runs this same
// GDScript (it reads it from this file) to replay recorded sessions of the real-workload ports.
import type { Node } from "godot";

export type InputReplayMode = "record" | "replay";
export const DEFAULT_INPUT_REPLAY_PATH = "user://input.replay";

/** What the recorder node answers to `status()`: frames counted, events recorded or fed, replay finished. */
export interface InputReplayStatus { mode: InputReplayMode; frame: number; events: number; done: boolean }

// The markers let examples/_kit/harness/recorder.gd extract the GDScript; keep them on their own lines.
export const INPUT_REPLAY_GD = String.raw`
// <input-replay.gd>
extends Node
# input-replay core (starter/src/lib/input-replay.ts): record the window's input events, or feed a recording back at the same frames.
signal finished
var mode := ""
var path := ""
var frame := 0
var events := 0
var done := false
var at := PackedInt64Array()  # replay: the frame of each event, in file order
var text := PackedStringArray()  # replay: each event as var_to_str (parsed when fed: a long recording holds no objects)
var next := 0
var file: FileAccess


func start(p_mode: String, p_path: String) -> String:
	mode = p_mode
	path = p_path
	process_mode = Node.PROCESS_MODE_ALWAYS
	if mode == "record":
		file = FileAccess.open(path, FileAccess.WRITE)
		if file == null:
			return "cannot write %s: %s" % [path, error_string(FileAccess.get_open_error())]
		file.store_line("# input-replay 1: <frame>\t<var_to_str(event)>; frame = _process calls of the recorder before the event arrived")
		return ""
	if mode == "replay":
		var f := FileAccess.open(path, FileAccess.READ)
		if f == null:
			return "cannot read %s: %s" % [path, error_string(FileAccess.get_open_error())]
		var n := 0
		while not f.eof_reached():
			var l := f.get_line()
			n += 1
			if l == "" or l.begins_with("#"):
				continue
			var tab := l.find("\t")
			var ev = str_to_var(l.substr(tab + 1)) if tab > 0 else null
			if not (ev is InputEvent) or not l.left(tab).is_valid_int():
				return "%s:%d is not <frame><TAB><InputEvent>" % [path, n]
			at.append(int(l.left(tab)))
			text.append(l.substr(tab + 1))
		return ""
	return "mode must be record or replay, not '%s'" % mode


func _ready() -> void:
	if mode == "record":
		get_window().window_input.connect(_on_window_input)
	elif mode == "replay":
		_feed()  # events recorded before the first frame


func _on_window_input(e: InputEvent) -> void:
	if file == null:
		return  # an event delivered after finish() (ticket 420)
	file.store_line("%d\t%s" % [frame, var_to_str(e).strip_edges().replace("\n", " ")])
	events += 1


func _process(_delta: float) -> void:
	frame += 1
	if mode == "replay":
		_feed()
	elif file != null and frame % 60 == 0:
		file.flush()


func _feed() -> void:
	while next < at.size() and at[next] <= frame:
		Input.parse_input_event(str_to_var(text[next]))
		next += 1
		events += 1
	if next == at.size() and not done:
		done = true
		finished.emit()


func status() -> Dictionary:
	return {"mode": mode, "frame": frame, "events": events, "done": done}


func finish() -> String:
	if file != null:
		file.close()
		file = null
	return "input_%s=%d input_frames=%d" % [mode, events, frame]


func _exit_tree() -> void:
	if file != null:
		file.close()
		file = null
// </input-replay.gd>
`.split("\n").filter((l) => !l.startsWith("// ")).join("\n");

type Godot = {
  GDScript: new () => { source_code: string; reload(keepState?: boolean): number };
  Node: new () => Node & { set_name(name: string): void; call(method: string, ...args: unknown[]): unknown };
  OS: { get_cmdline_user_args(): { size(): number; get(i: number): string } };
};

/** Add the recorder (or player) as a child of `parent`, now. Throws when the file cannot be opened or a line is not an event. */
export function startInputReplay(parent: Node, mode: InputReplayMode, path: string = DEFAULT_INPUT_REPLAY_PATH): Node {
  const g = require("godot") as Godot;
  const script = new g.GDScript();
  script.source_code = INPUT_REPLAY_GD;
  if (script.reload() !== 0) throw new Error("input-replay: the GDScript core does not compile");
  const node = new g.Node();
  node.set_name("InputReplay");
  node.set_script(script as never);
  const err = node.call("start", mode, path) as string;
  if (err !== "") throw new Error(`input-replay: ${err}`);
  parent.add_child(node);
  return node;
}

/** `-- --record[=path]` or `-- --replay=path` on the command line: start that; otherwise do nothing and return null. */
export function inputReplay(parent: Node, args?: string[]): Node | null {
  const argv = args ?? (() => {
    const a = (require("godot") as Godot).OS.get_cmdline_user_args();
    return Array.from({ length: a.size() }, (_, i) => a.get(i));
  })();
  for (const a of argv) {
    if (a === "--record") return startInputReplay(parent, "record");
    if (a.startsWith("--record=")) return startInputReplay(parent, "record", a.slice(9));
    if (a.startsWith("--replay=")) return startInputReplay(parent, "replay", a.slice(9));
  }
  return null;
}

/** Frames counted, events recorded or fed so far, and whether a replay has fed its last event. */
export function inputReplayStatus(node: Node): InputReplayStatus {
  const d = (node as unknown as { call(m: string): { get(k: string): unknown } }).call("status");
  return { mode: d.get("mode") as InputReplayMode, frame: Number(d.get("frame")), events: Number(d.get("events")), done: Boolean(d.get("done")) };
}

/** Close the recording file (also done when the node leaves the tree); returns "input_<mode>=<events> input_frames=<frames>". */
export function finishInputReplay(node: Node): string {
  return String((node as unknown as { call(m: string): unknown }).call("finish"));
}
