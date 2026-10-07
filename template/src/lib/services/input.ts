// Game services kit: Input, a Stream of action events plus `isPressed`, fed from a node's `_input`. OPT-IN, Effect projects
// only (not in tools/toolchain-files.json, removed by create-godotjs-bun --no-effect). Imports Effect by subpath.
// Tested by starter/tests/effect-services (logic.test.ts with the test bridge, the engine scene with parse_input_event).
//
//   const input = makeInputBridge(["jump", "fire", "move_left"]);       // InputMap actions that exist
//   class Player extends Node { _input(ev) { input.handle(ev); } }       // the node forwards its events
//   program.pipe(Effect.provide(Input.layer(input)));                    // tests: Input.testLayer(bridge), bridge.press("jump")
//   const events = yield* (yield* Input).subscribe;                      // a Stream of { action, pressed, strength }
//
// Rules this encodes (all measured in starter/tests/effect-primitives group 1):
//  1. Events arrive one frame LATE: Input.parse_input_event never delivers synchronously, so a test must wait a frame.
//  2. Nothing is dropped: the bridge publishes into an UNBOUNDED PubSub (500 events in one frame all arrived in order; a
//     sliding queue of 64 kept 64). A slow consumer grows memory instead of losing a press.
//  3. Mouse motion is accumulated by the engine (`Input.use_accumulated_input` is true by default): 5 motions in a frame
//     reach `_input` as ONE event. Mouse motion is not an action here; a game that counts motion events turns accumulation off.
//  4. `events` and `subscribe` see events published AFTER subscribing. Use `subscribe` (scoped) when a press must not be
//     missed between "start the fiber" and "the fiber is listening"; `events` subscribes when the stream starts running.
//  5. `isPressed` / `strength` follow the events this service saw (the last event per action wins), not Input.is_action_pressed,
//     so the stream and the state can never disagree. Key repeat (echo) events are ignored unless `echo: true`.
//  6. Every action name must exist in the InputMap: asking an event about an unknown action prints an engine ERROR.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface InputActionEvent {
  readonly action: string;
  readonly pressed: boolean;
  /** 0..1 for an analog action (a stick, a trigger); 1 for a key; 0 on release. */
  readonly strength: number;
}

export interface InputShape {
  /** Every action event, in order, from the moment the stream starts running. */
  readonly events: Stream.Stream<InputActionEvent>;
  /** Subscribe NOW (inside a Scope); the returned Stream holds every event from this moment on. */
  readonly subscribe: Effect.Effect<Stream.Stream<InputActionEvent>, never, Scope.Scope>;
  readonly isPressed: (action: string) => Effect.Effect<boolean>;
  readonly strength: (action: string) => Effect.Effect<number>;
}

/** The slice of an engine InputEvent the bridge asks about. Read plain fields inside `handle`; never keep the event. */
export interface RawInputEvent {
  is_action(action: string): boolean;
  is_action_pressed(action: string, allowEcho?: boolean): boolean;
  is_action_released(action: string): boolean;
  get_action_strength(action: string): number;
  is_echo(): boolean;
}

export interface InputBridge {
  readonly layer: Layer.Layer<Input>;
  /** Forward a node's `_input(ev)` here. Returns how many action events it published. */
  handle(ev: RawInputEvent): number;
  /** Publish an action event directly (what `handle` does per matching action). Tests use this, or press / release. */
  publish(ev: InputActionEvent): void;
  press(action: string, strength?: number): void;
  release(action: string): void;
  /** Forget the pressed state (a scene change, a pause menu): nothing is published. */
  reset(): void;
}

export function makeInputBridge(actions: readonly string[], options: { readonly echo?: boolean } = {}): InputBridge {
  const bus = Effect.runSync(PubSub.unbounded<InputActionEvent>());
  const held = new Map<string, number>();
  const publish = (ev: InputActionEvent) => {
    if (ev.pressed) held.set(ev.action, ev.strength);
    else held.delete(ev.action);
    PubSub.publishUnsafe(bus, ev);
  };
  const shape: InputShape = {
    events: Stream.fromPubSub(bus),
    subscribe: Effect.map(PubSub.subscribe(bus), (sub) => Stream.fromSubscription(sub)),
    isPressed: (a) => Effect.sync(() => held.has(a)),
    strength: (a) => Effect.sync(() => held.get(a) ?? 0),
  };
  return {
    layer: Layer.succeed(Input, shape),
    handle(ev) {
      if (!options.echo && ev.is_echo()) return 0;
      let n = 0;
      for (const action of actions) {
        if (!ev.is_action(action)) continue;
        const pressed = ev.is_action_pressed(action, true);
        if (!pressed && !ev.is_action_released(action)) continue;
        publish({ action, pressed, strength: pressed ? ev.get_action_strength(action) : 0 });
        n++;
      }
      return n;
    },
    publish,
    press: (action, strength = 1) => publish({ action, pressed: true, strength }),
    release: (action) => publish({ action, pressed: false, strength: 0 }),
    reset: () => held.clear(),
  };
}

export class Input extends Context.Service<Input, InputShape>()("game.Input") {
  /** Live: the service fed by `bridge.handle(ev)` from a node's `_input`. */
  static layer = (bridge: InputBridge): Layer.Layer<Input> => bridge.layer;
  /** Test: the same service with a bridge the test pushes into (`bridge.press("jump")`); no engine, no frame delay. */
  static testLayer = (bridge: InputBridge = makeInputBridge([])): Layer.Layer<Input> => bridge.layer;
}
