// Leak-free forms of the engine calls that leak under GodotJS (the "leak family", engine defect; tickets 201, 231, 260).
// OPT-IN, no Effect needed; NOT in tools/toolchain-files.json (copy it into a game that wants it).
//
// The defect: a RefCounted the engine hands to JS is never freed when, at that moment, the engine still holds it somewhere
// else too (a tween the SceneTree runs, the collision a body caches, the InputEvent the viewport is dispatching). One object
// per call, for the whole session. GDScript frees them, so each helper below lets a tiny GDScript relay (compiled at run
// time from the source string below: no .gd file to ship) touch the engine object and hands JS only plain values or a copy.
//
//   import { onInputEvent, slideCollisions, tweenProperty } from "./lib/leak-free";
//   onInputEvent(this, (ev) => { if (ev.is_action_pressed("pause")) ... });    // instead of _input / _unhandled_input
//   for (const c of slideCollisions(this)) if (c.collider instanceof Mob && c.normal.dot(Vector3.UP) > 0.1) ...
//   tweenProperty(sprite, "modulate:a", 0, 0.3, () => sprite.queue_free()); // instead of create_tween().tween_property
//
// Timers: `setTimeout`, `FrameClock.sleepCounting` or a `Timer` node do not leak; `create_timer` does.
// Pinned by starter/tests/leak-family (cases kit-*); mechanism and measurements: docs/design/leak-family.md in godotjs-esm.
// @ts-ignore GDScript is missing from the shim typings used before `bun run types` (a namespace import breaks the bundle)
import { GDScript, Callable, Node } from "godot";

const RELAY_SOURCE = `extends Node
signal relayed(ev)

func _input(event):
	relayed.emit(event.duplicate())

func _unhandled_input(event):
	relayed.emit(event.duplicate())

static func slide(body) -> Array:
	var out := []
	for i in body.get_slide_collision_count():
		var c = body.get_slide_collision(i)
		out.append([c.get_collider(), c.get_normal(), c.get_position(), c.get_angle()])
	return out

static func tween_property(node, path, to, seconds, done) -> void:
	var t = node.create_tween()
	t.tween_property(node, path, to, seconds)
	if done.is_valid():
		t.finished.connect(done, CONNECT_ONE_SHOT)
`;

type GodotAny = any; // the relay is a runtime GDScript: its members are not in the typings
let relay: GodotAny = null;

function relayScript(): GodotAny {
  if (relay) return relay;
  const s = new (GDScript as GodotAny)();
  s.source_code = RELAY_SOURCE;
  const err = s.reload();
  if (err !== 0) throw new Error(`leak-free: relay GDScript failed to compile (error ${err})`);
  relay = s;
  return relay;
}

/** One slide collision as plain values (no KinematicCollision object reaches JS). */
export type SlideCollision<V> = { collider: unknown; normal: V; position: V; angle: number };

/** The collisions of the last `move_and_slide()` of a CharacterBody2D or CharacterBody3D, like a loop over
 * `get_slide_collision(i)`, without leaking one KinematicCollision per call. */
export function slideCollisions<V = GodotAny>(body: Node): SlideCollision<V>[] {
  const arr = relayScript().call("slide", body);
  const out: SlideCollision<V>[] = [];
  for (let i = 0, n = arr.size(); i < n; i++) {
    const c = arr.get(i);
    out.push({ collider: c.get(0), normal: c.get(1), position: c.get(2), angle: c.get(3) });
  }
  return out;
}

/** Receive the input events `node` would get in `_input` (or `_unhandled_input` with `unhandled: true`), each as a copy
 * that is freed. Do not also define `_input` / `_unhandled_input` on the class (that one leaks). The relay is a child of
 * `node`, so it is freed with it; returns the relay. `get_viewport().set_input_as_handled()` works inside the handler. */
export function onInputEvent(node: Node, handler: (event: GodotAny) => void, options: { unhandled?: boolean } = {}): Node {
  const unhandled = options.unhandled === true;
  const n: GodotAny = new Node();
  n.set_script(relayScript());
  n.set_name(unhandled ? "LeakFreeUnhandledInput" : "LeakFreeInput");
  n.connect("relayed", Callable.create(handler));
  node.add_child(n);
  n.set_process_input(!unhandled); // _ready enabled both, because the relay defines both
  n.set_process_unhandled_input(unhandled);
  return n;
}

/** `node.create_tween().tween_property(node, path, to, seconds)`, made by the relay so the Tween and its tweener never
 * reach JS. `done` runs once when it finishes. For chains, parallel steps or easing, use an AnimationPlayer or animate in
 * `_process`; a tween made from JS leaks 2 objects (cheap for a menu fade, not for one per bullet). */
export function tweenProperty(node: Node, path: string, to: unknown, seconds: number, done?: () => void): void {
  relayScript().call("tween_property", node, path, to, seconds, done ? Callable.create(done) : new (Callable as GodotAny)());
}
