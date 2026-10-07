# Effect cookbook for a whole game

Effect projects only. Every section is one idiom a small real-time game needs, in the same shape: **Rule**, code, **Verified by** (a named test with a negative control), **Trap**. A status word heads each section: `VERIFIED` means every claim in it is pinned by a named test; `PARTLY` means the mechanism is pinned but not in exactly this use, and the section says what is missing. Every ` ```ts ` block here is type-checked by `bun tools/check-docs-snippets.ts` (part of `bun tools/verify.ts --quick`); a block that is intentionally partial says so on its first line. Catalogue, matrices and gaps: `docs/design/effect-game-patterns.md`. Daily rules (hot reload, closures): `docs/DAILY.md`.

## Start here

The five rules that matter most (each is measured, see the sections):

| # | Rule | Why | Section |
|---|---|---|---|
| 1 | Import Effect by subpath: `import * as Effect from "effect/Effect"`, never `from "effect"` | the barrel pulls the whole library into every script bundle (48 ms and 3.3 MiB per bundle) | 21 |
| 2 | Every service has a unique string key: `Context.Service<Foo, Shape>()("game.Foo")` | two services with the same key silently replace each other | 21 |
| 3 | At the edges use `runLogged` / `forkLogged`, and add `catchCause` to node fibers | bare `runFork` fails silently, bare `runPromise` prints no stack; `forkOnNode` does not log | 15 |
| 4 | Convert data with `Schema.toCodecJson` before it crosses into Godot | `Map`, `Set`, `Date`, `Option` and class instances throw or lose their type at the boundary | 23 |
| 5 | Fold per-frame updates into ONE publish per frame | one `SubscriptionRef.update` is 32 us: 200 per frame blow the 4 ms budget, one folded update is 0.14 ms | 4 |

Also: `freeNode` not `queue_free`, closures call `this.method()` (hot reload), at most 4 ms of Effect per frame, per-entity math stays a plain loop.

### A tiny game loop (the services kit, `godot-effect.ts`, `game-clock.ts`)

An arena where `fire` shoots with a sound, a wave spawns every two game seconds at a seeded random position, and the score is folded once per frame. It uses Settings, Input, Assets, Audio, Random (GodotConfig is in the same `GameServicesLive`; read flags with `Config.Boolean`, section 14b).

```ts
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Button, InputEvent, Label, Node2D } from "godot";
import { makeGameClock } from "./lib/game-clock";
import { Frames, forkOnNode, nodeScope, signalStream } from "./lib/godot-effect";
import { Assets, Audio, GameServicesLive, Input, Random, Settings, makeInputBridge } from "./lib/services";

const Score = Schema.Struct({ points: Schema.Number });          // plain data: it can go to the save and across the boundary

const run = (arena: Arena) => Effect.gen(function* () {         // closures call methods on `arena`, never inline logic (hot reload)
  const settings = yield* Settings;
  const audio = yield* Audio;
  const rng = yield* Random;
  yield* audio.setBusVolume("Master", yield* settings.get("audio", "master", Schema.Number, 0.8));
  yield* (yield* Assets).preload(["res://enemy.tscn"]);          // threaded; a typo is a typed AssetNotFound
  const keys = yield* (yield* Input).subscribe;                   // every event from now on, none dropped
  yield* Effect.forkChild(keys.pipe(
    Stream.filter((e) => e.action === "fire" && e.pressed),
    Stream.runForEach(() => audio.play("shot").pipe(Effect.andThen(Effect.sync(() => arena.shoot()))))));
  yield* Effect.forkChild(Effect.repeat(                          // on GAME time: frozen while paused
    Effect.gen(function* () { arena.spawn(yield* rng.int(0, 640)); }), Schedule.spaced(2000)));
  yield* Effect.forkChild(signalStream(arena.restart.pressed).pipe(Stream.runForEach(() => Effect.sync(() => arena.reset()))));
  yield* arena.frames.processStream.pipe(Stream.runForEach(() => Effect.sync(() => arena.flush())));   // ONE fold per frame
});

class Arena extends Node2D {
  frames = new Frames();
  bridge = makeInputBridge(["fire"]);
  label!: Label;
  restart!: Button;
  points = 0;
  hits = 0;                                                       // plain counters: events add here, flush() folds them
  _process(d: number) { this.frames.process(d); }
  _input(ev: InputEvent) { this.bridge.handle(ev); }
  _ready() {
    const ns = nodeScope(this);                                   // closes when this node leaves the tree
    const clock = makeGameClock(this.get_tree());
    Effect.runSync(Scope.addFinalizer(ns.scope, Effect.sync(() => clock.dispose())));   // runs AFTER the fibers are interrupted
    const services = GameServicesLive({ input: this.bridge, audio: { parent: this, sounds: { shot: "res://shot.wav" } }, seed: 42 });
    forkOnNode(ns, run(this).pipe(
      Effect.provide(services), Effect.provideService(Clock.Clock, clock),
      Effect.catchCause((c) => Effect.sync(() => console.log(`ERROR [arena] ${Cause.pretty(c)}`)))));
  }
  shoot() { this.hits += 1; }
  spawn(x: number) { /* instantiate and add_child at x */ }
  reset() { this.points = 0; this.hits = 0; }
  flush() { if (this.hits) { this.points += 10 * this.hits; this.hits = 0; this.label.text = `score ${this.points}`; } }
}
```

Tests for this program need no engine: `GameServicesTest({ seed: 1, sounds: { shot: 1 } })` gives every service in memory, `t.input.press("fire")` drives it, `TestClock` moves the waves (section 18).

## Status

| # | Section | Status | # | Section | Status |
|---|---|---|---|---|---|
| 1 | Game loop | VERIFIED | 13 | Save and load | VERIFIED (prototype) |
| 2 | Input | VERIFIED | 14 | Settings | VERIFIED |
| 3 | Entity lifecycle | VERIFIED | 14b | Config, debug flags | VERIFIED |
| 4 | Game state store | VERIFIED | 15 | Logging, error boundaries | VERIFIED |
| 5 | Event bus | VERIFIED | 16 | Pause and time scale | VERIFIED |
| 6 | Cooldowns on game time | VERIFIED | 17 | Hot reload, devState | VERIFIED |
| 7 | Scene transitions, loading | VERIFIED | 18 | Testing | VERIFIED |
| 8 | UI binding | VERIFIED | 19 | Hot-loop budget | VERIFIED |
| 9 | Physics callbacks | VERIFIED | 20 | Waves on a Schedule | VERIFIED |
| 10 | Tweens | VERIFIED | 21 | Services and Layers | VERIFIED |
| 11 | Audio | VERIFIED | 22 | Run scope, restart | VERIFIED |
| 12 | Randomness | VERIFIED | 23 | Data across the boundary | VERIFIED |
| | | | 24 | Soak and leak checks | PARTLY |

Test projects (all under `starter/tests/`): EG `effect-godot`, EP `effect-primitives`, ET `effect-time`, EC `effect-core`, ES `effect-services`, EB `effect-boundary`, EV `effect-save`, EM `effect-model`, CO `effect-cost`, EN `effect-entities`, EBUS `effect-bus`.

Common imports (every block below gets the ones it uses added by the checker; copy what you need):

```ts
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import { Frames, forkLogged, forkOnNode, freeNode, nodeScope, runLogged, signalOnce, signalStream } from "./lib/godot-effect";
```

## 1. Game loop and per-frame work

VERIFIED. **Rule:** the node forwards `_process` to `Frames`; fibers wait on `processStream`; per-entity math is a plain loop, Effect starts, waits, retries or fails.

```ts
class Arena extends Node2D {
  frames = new Frames();
  _process(d: number) { this.frames.process(d); }
  _physics_process(d: number) { this.frames.physics(d); }
  _ready() {
    const ns = nodeScope(this);
    forkOnNode(ns, this.frames.processStream.pipe(Stream.runForEach((d) => Effect.sync(() => this.tick(d)))));
  }
  tick(d: number) { /* plain JS: move entities, no Effect per entity */ }
}
```

**Verified by:** EG group 3 (`frames-fiber-per-node`, `frames-sleep-and-next-process`, `frames-race-process-vs-physics`, `frames-repeat-per-frame-schedule`, control `frames-fiber-not-cancelled`); CO budgets (`effect-sync-batched`, `fibers-yield-1000-frame-p50`). **Trap:** 4 ms of Effect per frame is about 350 `runSync`; cost table in `docs/design/effect-cost.md`.

## 2. Input as a Stream

VERIFIED. **Rule:** the node forwards `_input(ev)` to the kit's bridge; programs subscribe to a Stream of `{ action, pressed, strength }`. Held movement (`Input.get_vector`) is read in the frame fiber, not as a stream.

```ts
class Player extends CharacterBody2D {
  bridge = makeInputBridge(["jump", "fire"]);          // actions that exist in the InputMap
  _input(ev: InputEvent) { this.bridge.handle(ev); }   // copies plain fields, keeps no engine object
}
const jumps = Effect.gen(function* () {
  const events = yield* (yield* Input).subscribe;      // from this moment, unbounded, nothing dropped
  yield* events.pipe(Stream.filter((e) => e.action === "jump" && e.pressed), Stream.runForEach(() => Effect.log("jump")));
});
// provide it with Input.layer(player.bridge); tests: Input.testLayer(bridge) and bridge.press("jump")
```

**Verified by:** ES engine `input-event-arrives-next-frame-as-a-stream-element`, `input-500-events-in-one-frame-none-dropped` (control: a sliding bridge keeps 64), `input-real-key-event-through-the-inputmap-and-echo-ignored`, `input-non-action-events-publish-nothing-and-mouse-motion-is-accumulated-by-the-engine`; EP `input-delivery-is-deferred`, `input-order-through-queue-and-stream`, `input-500-in-one-frame-no-loss`, `input-set-input-as-handled`, `input-mouse-motion-accumulated-by-default`.

**Trap:** an injected or real event reaches `_input` in the NEXT frame. Mouse motion is accumulated (5 events arrive as ONE, `relative` summed) unless `Input.use_accumulated_input = false`. An event marked `set_input_as_handled()` never reaches `_unhandled_input`. An action name missing from the InputMap prints an engine ERROR.

## 3. Entity lifecycle: spawn, despawn

VERIFIED (script-class nodes). Verified: one node scope per entity, fibers interrupted on free, waves of real `Area2D` nodes each with an AI fiber, a lifetime timer and a hit stream, despawn by timeout, by a hit signal and by the run ending, an object pool (a reused node never receives an event from its previous life), 50 nodes with scopes and fibers freed five times without a leak, random spawn/free/reparent sequences against a model. Not verified: `PackedScene.instantiate` of a wave in chunks (EN builds its entities with `ResourceLoader.load(script).call("new")`; the 250-fibers-per-frame figure is measured for fibers, not for instantiated scenes).

```ts
const spawn = (scene: PackedScene, parent: Node, at: Vector2) => {
  const e = scene.instantiate() as Enemy;
  parent.add_child(e);          // enters the tree: its nodeScope closes on tree_exiting
  e.position = at;
  return e;                     // Enemy._ready does: forkOnNode(nodeScope(this), this.behaviour())
};
class Enemy extends Node2D { _ready() { forkOnNode(nodeScope(this), Effect.never); } }
// despawn: freeNode(e)  (scope closes, fibers interrupted, finalizers run)
```

**Pool.** A pooled node stays in the tree, so `tree_exiting` never closes its life: each LIFE gets its own `nodeScope` (it is one-shot) and `release` closes it by hand. A node released into the pool then has 0 fibers, 0 connections and 0 `Frames` listeners; reuse arms a new life.

```ts
class Pooled extends Node2D {
  frames = new Frames();
  ns: NodeScope | null = null;
  closing: Promise<void> | null = null;
  _process(d: number) { this.frames.process(d); }
}
const acquire = async (pool: Pooled[], make: () => Pooled, behaviour: (e: Pooled) => Effect.Effect<void>) => {
  const e = pool.pop() ?? make();
  await e.closing;                              // the interrupt is synchronous, only this promise settles a turn later
  e.visible = true;
  e.process_mode = 0;                           // inherit
  e.ns = nodeScope(e);                          // a NEW scope per life
  forkOnNode(e.ns, behaviour(e));
  return e;
};
const release = (pool: Pooled[], e: Pooled) => {
  e.closing = e.ns!.close();                    // fibers interrupted, streams disconnected, Frames listener removed
  e.visible = false;
  e.process_mode = 4;                           // PROCESS_MODE_DISABLED
  pool.push(e);                                 // on an Area2D also: e.set_deferred("monitoring", false), never inside a physics callback
};
```

**Verified by:** EG `scope-tree-exiting`, `scope-queue-free-sleepers`, `scope-reparent-closes`, control `fibers-not-tied-to-node`; EP `restart-5-runs-no-stray-fibers-nodes-connections`; EM (Spawn, AddChild, Free, QueueFree, Reparent, Fork, Interrupt, gate seed 20261007); EN `spawn-despawn-by-timeout-hit-and-run-end`, `entity-owns-fibers-connections-and-ticks-while-alive`, `despawn-is-idempotent-two-hits-one-despawn`, `despawn-leaves-no-late-event-after-free`, control `despawn-skips-scope-close-fails-leak-check`; pool: EN `pool-acquire-release-reuse-rearms`, `pool-reused-node-never-receives-events-from-previous-life`, `pool-parked-node-is-inert-and-reuse-wakes-it`, `pool-release-then-acquire-in-the-same-turn`, controls `pool-forgets-to-clean-a-fiber-fails-reuse-invariant`, `hit-pool-leaves-life-open-parked-node-gets-a-late-event`. **Trap:** `reparent()` closes the scope; a node freed without ever entering the tree never closes it (`scope-never-in-tree-known-gap`: call `ns.close()`); a hit signal reaches the despawn through a Stream and a fiber, so it runs one microtask AFTER `emit_signal`, not inside it (EN `pool-signal-despawn-is-a-turn-later-than-the-emit`): make the despawn idempotent (two hits in a turn: EN `despawn-is-idempotent-two-hits-one-despawn`); a pool that forgets to close the life keeps old timers (they despawn the new life) and doubles the connections; start fibers in chunks of at most 250 per frame; do not pool nodes for the collector's sake (no spike measured: pooling is verified correct, not shown faster).

## 4. Game state store

VERIFIED. **Rule:** state is plain data; one pure reducer `(state, action) => state`; events during the frame go into a plain array; ONE fiber folds the array and publishes once per frame into a `SubscriptionRef`.

```ts
type GameState = { score: number; wave: number };
type Action = { _tag: "Hit"; points: number } | { _tag: "NextWave" };
export const reduce = (s: GameState, a: Action): GameState =>
  a._tag === "Hit" ? { ...s, score: s.score + Math.max(0, a.points) } : { ...s, wave: s.wave + 1 };   // never subtract score

class Hud extends Node {
  frames = new Frames();
  pending: Action[] = [];                       // callbacks push here (plain fields)
  score!: Label;
  show(s: GameState) { this.score.text = `score ${s.score}`; }
}
const hudLoop = (hud: Hud) => Effect.gen(function* () {
  const store = yield* SubscriptionRef.make<GameState>({ score: 0, wave: 1 });
  yield* Effect.forkChild(SubscriptionRef.changes(store).pipe(Stream.runForEach((s) => Effect.sync(() => hud.show(s)))));
  yield* hud.frames.processStream.pipe(Stream.runForEach(() => {
    const batch = hud.pending.splice(0);       // the whole frame at once
    return batch.length ? SubscriptionRef.update(store, (s) => batch.reduce(reduce, s)) : Effect.void;
  }));
});
```

**Verified by:** EP `store-label-equals-final-value-batched`, `store-200-separate-updates-cost-per-update` (about 32 us each, 6.5 ms for 200: over budget), `store-folded-reducer-inside-4ms-budget` (0.14 ms), control `store-label-stale-without-consumer`; EC `ref`, `queue`. **Trap:** no `Map`, `Set` or class in the state (`devState`, the save and Godot hold plain data); the Label write is cheap (8000 writes unmeasurable) but do it once per frame anyway; `Ref.update` is 12 us, so no per-entity state through it.

## 5. Event bus

VERIFIED (EBUS = `starter/tests/effect-bus`, 32 checks and 17 negative controls in one launch, about 10 s). **Rule:** one game-wide `PubSub<GameEvent>` as a service; a subscriber is a NODE: a fiber on the node's scope whose subscription lives in the FIBER's own `Effect.scoped`; engine callbacks (signals, `_input`) only append to a plain array and ONE `publishAll` per frame feeds the bus; subscribers that may see many events use `takeAll`. The bus belongs to the run scope (`acquireRelease` with `PubSub.shutdown`).

```ts
type GameEvent = { _tag: "EnemyDied"; at: number } | { _tag: "Paused" };
class Events extends Context.Service<Events, PubSub.PubSub<GameEvent>>()("game.Events") {
  // unbounded: nothing is lost and publishUnsafe always accepts; a stuck subscriber costs memory, it never stalls the game
  static layer = Layer.effect(Events, Effect.acquireRelease(PubSub.unbounded<GameEvent>(), PubSub.shutdown));   // shut down with the run scope
}
// a subscriber NODE: the fiber ends with the node, the subscription ends with the fiber (also when the handler throws)
const listen = (ns: NodeScope, bus: PubSub.PubSub<GameEvent>, on: (e: GameEvent) => void) =>
  forkOnNode(ns, Effect.scoped(Effect.gen(function* () {
    const sub = yield* PubSub.subscribe(bus);                     // subscribed synchronously when the fork returns
    while (true) for (const e of yield* PubSub.takeAll(sub)) on(e);   // one wake per publishAll, not per event
  })));
// engine callbacks never publish one by one: collect, then flush once per frame (a plain process_frame connection, or your Frames driver)
const pending: GameEvent[] = [];
const flush = (bus: PubSub.PubSub<GameEvent>) => { if (pending.length) Effect.runSync(PubSub.publishAll(bus, pending.splice(0))); };
// `sliding(n)` instead of unbounded when a subscriber may fall behind: publish with the EFFECT, which honours the strategy and never suspends there
const publishSliding = (bus: PubSub.PubSub<GameEvent>, e: GameEvent) => Effect.runSync(PubSub.publish(bus, e));
```

**Verified by (EBUS, every name is `effect-bus-<name>`; each group also has controls, listed at the end):**

| Claim | Test |
|---|---|
| A live subscriber on an unbounded bus gets every event in publication order (1,020 events, two interleaved sources, three subscribers; `Stream.fromPubSub` and an explicit `subscribe` give the same result). Subscribing is synchronous, a late joiner sees exactly the events published after its `subscribe`, no gap | `bus-live-subscribers-get-every-event-in-order`, `bus-late-joiner-sees-only-later-events-and-no-gap` |
| Nothing is delivered after the subscriber's scope closed, whether the node left by `queue_free`, `remove_child`, `reparent` (reparent closes the scope: resubscribe in the new parent) or `scope.close()`; the left subscription does not hold a bounded bus; the staying subscriber misses nothing. `queue_free` is deferred: events published in the same frame are still delivered (the node is in the tree until the end of the frame); a handler that frees its own node still sees the rest of that frame's burst | `bus-leave-by-{queue-free,remove-child,reparent,scope-close}-no-delivery-after-scope-closed`, `bus-handler-frees-own-node-burst-finishes-then-silence` |
| A subscriber that is BEHIND loses events only on a bounded-with-strategy bus: `sliding(8)` with `PubSub.publish` keeps the NEWEST 8 (all publishes accepted), `dropping(8)` keeps the OLDEST 8 | `bus-sliding-publish-keeps-newest`, `bus-dropping-publish-keeps-oldest` |
| **`PubSub.publishUnsafe` ignores the strategy** (Effect 4.0.1, its own doc says so): on a `sliding` bus it refuses the newest like `dropping` (returns false). Use `Effect.runSync(PubSub.publish(...))` on a sliding or dropping bus (never suspends there), `publishUnsafe` only on an unbounded one | `bus-publishUnsafe-ignores-sliding-keeps-oldest`, `bus-sliding-publish-never-suspends` |
| **Backpressure:** on a `bounded(8)` bus the Effect `publish` is held to the SLOWEST subscriber, and so are the fast subscribers (slow takes 1 per frame: after 10 frames the publisher had published 19 and the fast subscriber had 19). `publishUnsafe` never blocks and refuses (loses) the newest (9 of 100 accepted). `Effect.runSync(PubSub.publish(...))` on a full bounded bus throws `AsyncFiberError`. Safe choice: unbounded, or sliding with `publish` | `bus-bounded-slow-subscriber-stalls-publisher-and-fast-subscriber`, `bus-bounded-publishUnsafe-refuses-never-blocks`, `bus-bounded-runSync-publish-on-full-bus-throws` |
| A subscriber that fails (`Effect.fail`), dies (`Effect.die`) or throws a JS error ends ITS fiber only (its failing event is recorded, nothing after); the bus stays open and the others get every event. With `forkLogged` each prints one `ERROR [effect] <label> failed:` report (checked in `run.sh`); `forkOnNode` alone prints nothing | `bus-failing-subscriber-does-not-stop-the-others`, `bus-failing-subscriber-fiber-ends-at-the-failure`, `bus-stays-open-after-failures` |
| **Where the subscription lives matters for a dead subscriber on a bounded bus:** in the fiber's `Effect.scoped` it is released at the failure and the bus is not held; in the NODE's scope (`forkOnNode(ns, body)` with `subscribe` inside, no `scoped`) the dead subscriber's subscription stays until the node leaves, its queue fills and the publisher blocks (16 of 20 `publishUnsafe` refused, Effect `publish` blocked) | `bus-dead-subscriber-in-fiber-scope-does-not-hold-a-bounded-bus`, `bus-dead-subscriber-in-node-scope-holds-a-bounded-bus-until-the-node-leaves` |
| A signal bridge (`signalStream` on the emitter's node scope publishing to the bus) delivers all in order and disconnects with the scope (1 connection while bridged, 0 after) | `bus-signal-bridge-delivers-all-in-order-then-disconnects` |
| **Budget, 50 subscriber nodes at 100 events per frame (5,000 deliveries):** batched (array, one `publishAll`, `takeAll` subscribers) median **3.5 ms** per frame from a signal and 3.5 ms from `_input` (best of 3 windows of 20 frames; headroom 0.5 ms; windows within 0.1 ms of each other). Per event (`publishUnsafe` or `signalStream` + `publish`, one fiber wake per delivery): 73 ms with a `take` loop (15 us per delivery), 117 ms with `Stream.fromPubSub` (23 us): 20 to 30 times over the budget. The cost is a fixed 27 us per subscriber FIBER per frame plus 0.45 us per delivery: 10 subscribers 0.96 ms, 25 subscribers 1.9 ms, 50 subscribers 3.5 ms (100 per frame); 400 per frame to 50 subscribers 10.9 ms | `bus-fanout-signal-batched-50-subscribers-100-per-frame-within-4ms`, `bus-fanout-input-batched-50-subscribers-100-per-frame-within-4ms`, `bus-fanout-per-event-delivers-everything-in-order` |
| **Pause and `time_scale` 0:** publishing and DIRECT subscribers (waiting on the bus) ignore both. A publisher driven by a `Frames` fiber follows its node's process mode (0 published while paused for a pausable node, 10 of 10 for `process_always`). A FRAME-PACED consumer (`nextProcess` then `takeAll`) freezes with its node: on an unbounded bus it catches up after the unpause with identical events and order, on `sliding(8)` only the newest 8 of 30 events published during the pause survive. A node freed while paused leaves the bus (its scope closes during the pause). At `time_scale` 0 `_process` still ticks with delta 0 and `_physics_process` still ticks (measured, same count as at 1); only the game clock stops, the stock Effect clock does not | `bus-pause-publishers-follow-their-node-and-direct-subscriber-gets-everything`, `bus-pause-frame-paced-subscriber-freezes-with-its-node-and-loses-nothing`, `bus-pause-sliding-bus-keeps-only-the-newest-capacity-of-the-pause`, `bus-pause-node-freed-while-paused-leaves-the-bus`, `bus-time-scale-0-bus-and-process-and-physics-tick-game-clock-stops` |
| **Teardown (3 runs in one process, 23 live fibers each):** closing the run scope shuts the bus down, which ends EVERY subscriber fiber at once, including a node-scoped one and a forgotten bare one, while the nodes are still in the tree (0 fibers after the shutdown); then the nodes leave: node count and orphans at baseline, no `process_frame` connection, no emitter connection, `publishUnsafe` returns false, nothing delivered, `_input` hook detached, no leak line | `bus-teardown-3-runs-no-stray-fibers-nodes-connections`, `bus-shutdown-ends-every-subscriber-fiber-before-the-nodes-leave`, `bus-clean-after-controls` |

**Negative controls (each `effect-bus-control-<name>` passes only when its assertion FAILS):** `forgotten-scope-receives-late-event` (a subscriber on a private scope not linked to its node gets 30 late events after `queue_free`), `forgotten-scope-subscriber-receives-late-event-after-failures`, `pause-forgotten-scope-receives-late-event`, `forgotten-bridge-keeps-connection-and-delivers-late-event`, `sliding-bus-loses-events-for-a-slow-subscriber`, `publishUnsafe-on-sliding-does-not-keep-newest`, `one-fiber-for-all-subscribers-stops-on-a-throw`, `dead-subscriber-in-node-scope-fails-the-not-stalled-check`, `fanout-per-event-stream-breaks-the-budget`, `fanout-per-event-input-breaks-the-budget`, `pause-frozen-assertion-on-process-always-subscriber`, `pause-sliding-keeps-everything-assumption`, `time-scale-0-clock-sleeper-must-not-wake-assumption`, `teardown-skipped-leaves-fibers-and-nodes`, `teardown-forgot-bus-shutdown-forgotten-subscriber-lives`, `teardown-forgot-bridge-scope-leaves-emitter-connection`, `teardown-forgot-input-detach`. Pinned numbers and the raw INFO lines: `starter/tests/effect-bus/NOTES.md`.

**Trap:** (1) `publishUnsafe` on a `sliding` bus is a `dropping` bus (keeps the OLD events, refuses the new): the previous version of this section recommended exactly that. (2) A bounded bus holds the publisher AND every fast subscriber to the slowest or dead one: never `bounded` for game events. (3) One fiber wake per delivery costs 15 to 23 us: 50 subscribers x 100 events per frame is 73 to 117 ms, so batch (collect, `publishAll` once per frame, `takeAll`) or cut the subscriber count: each subscriber FIBER costs 27 us per frame even for one event. (4) Put `subscribe` inside the fiber's `Effect.scoped`, not in the node scope, or a failed subscriber keeps its subscription until the node leaves. (5) `reparent` closes the node's scope: the subscriber is gone, resubscribe after it. (6) Shut the bus down with the run scope: it is the safety net that ends forgotten subscribers (but it also means a late `publish` returns false silently). (7) A frame-paced subscriber on a pausable node freezes during pause while the bus keeps accepting: use `unbounded` if it must see everything after the unpause.

## 6. Commands and cooldowns on game time

VERIFIED. **Rule:** provide the game clock as `Clock`; `sleep`, `timeout`, `Schedule` then follow pause and `time_scale`.

```ts
declare const tree: SceneTree;                                     // this.get_tree() in a node
const clock = makeGameClock(tree);                                  // follows pause and time_scale
const cooldown = Effect.sleep(400).pipe(Effect.provideService(Clock.Clock, clock));
const attack = (ready: Ref.Ref<boolean>, strike: Effect.Effect<void>) => Effect.gen(function* () {
  if (!(yield* Ref.get(ready))) return;
  yield* Ref.set(ready, false);
  yield* strike;
  yield* Effect.forkChild(cooldown.pipe(Effect.andThen(Ref.set(ready, true))));
});
// when the owner leaves the tree: interrupt its fibers, THEN clock.dispose()
```

**Reproducible time (tests, replays, `--fixed-fps`):** the game clock follows wall time, so use `makeFrameClock()` (`src/lib/frame-clock.ts`): `_process(delta) { clock.advance(delta) }`, and `clock.timer(ms)` instead of `Schedule.spaced` for a repeating Godot-Timer cadence (`spaced` drifts one frame per cycle). Verified by `starter/tests/frame-clock` and the Dodge the Creeps port (`examples/dodge-the-creeps-ts`: 0 of 12000 frames differ from the GDScript original). **Verified by:** ET `game-clock-sleep`, `game-clock-paused`, `game-clock-time-scale`, `game-clock-effect-features`, `game-clock-interrupt`, `dispose-cycles-memory`, `testclock` (`sleep`, `spaced-schedule`, `deterministic`). **Trap:** the clock is frame-accurate, not millisecond-accurate; use `Schedule.spaced`, not `Schedule.fixed` (it can double-tick); a disposed clock never wakes its sleepers.

## 7. Scene transitions and loading

VERIFIED. **Rule:** load through the `Assets` service (threaded, typed errors, drains on interrupt); give it a timeout; swap scenes by hand or with `change_scene_to_packed`.

```ts
const toLevel = (tree: SceneTree) => Effect.gen(function* () {
  const assets = yield* Assets;
  const scene = yield* assets.loadThreaded<PackedScene>("res://level.tscn").pipe(Effect.timeout(5000));
  tree.change_scene_to_packed(scene);
}).pipe(Effect.catchTag("AssetNotFound", (e) => Effect.log(`no such scene ${e.path}`)));
```

**Verified by:** ES `assets-missing-path-is-a-typed-error-and-the-engine-prints-nothing`, `assets-interrupted-threaded-load-is-drained-no-pending-request` (control `assets-without-the-drain-the-finished-load-stays-pending`), `assets-timeout-is-an-effect-failure-and-the-loader-is-drained`; EP `load-threaded-as-effect`, `load-threaded-interrupt-then-no-leak`, `load-threaded-timeout-is-an-effect-failure`, `scene-change-to-packed-releases-layer`, `scene-swap-by-hand-remove-child-first-is-clean`.

**Trap:** a raw `load_threaded_request` of a missing path returns 0 and the loader prints two engine ERROR lines later: the service asks `ResourceLoader.exists` first. A finished load nobody takes leaks, so an interrupted load must drain (the service does). `change_scene_to_packed` frees the current scene and leaves `current_scene` null until the next frame. By hand: `remove_child(old); old.queue_free(); add_child(new)`; `queue_free()` alone keeps old and new alive together for a frame. Never judge a freed scene by `is_instance_valid` on its wrapper.

## 8. UI binding

VERIFIED. **Rule:** a button is a `signalStream` into an action; a store is a stream into a latch, and ONE frame callback writes the label.

```ts
class Menu extends Control {
  restart!: Button;
  score!: Label;
  latest = 0;
  dirty = false;
  _ready() {
    const ns = nodeScope(this);
    forkOnNode(ns, signalStream(this.restart.pressed).pipe(Stream.runForEach(() => Effect.sync(() => this.onRestart()))));
  }
  _process() { if (this.dirty) { this.dirty = false; this.score.text = `score ${this.latest}`; } }
  onRestart() { /* dispatch the Restart action */ }
  onScore(s: number) { this.latest = s; this.dirty = true; }     // called by the store's change stream
}
```

**Verified by:** EG `signal-stream`, `signal-stream-interrupt`, `signal-stream-emitter-freed`; EP `store-label-equals-final-value-batched`. **Trap:** assign properties (`label.text = ...`), never `node.position.x = 5` (it writes a copy); a signal on a freed emitter prints an engine ERROR unless you use `connectSignal`'s disconnect (`signalStream` does).

## 9. Physics callbacks

VERIFIED. **Rule:** `body_entered` as a Stream on the area's node scope; copy what you need INSIDE the callback.

```ts
const bodies = (sig: Signal) => Stream.callback<{ name: string }>((q) => Effect.acquireRelease(
  Effect.sync(() => connectSignal(sig, (b: Node) => Queue.offerUnsafe(q, { name: String(b.get_name()) }))), (off) => Effect.sync(off)));
class Mine extends Area2D {
  _ready() {
    forkOnNode(nodeScope(this), bodies(this.body_entered).pipe(Stream.runForEach((b) => Effect.log(`hit ${b.name}`))));
  }
}
```

**Verified by:** EP `physics-body-entered-exited-stream`, `physics-two-bodies-order`, `physics-body-freed-while-overlapping`, `physics-enter-and-free-same-frame`, `physics-no-event-after-scope-closed` (control: not interrupted delivers), `physics-area-freed-with-stream-running`, `physics-exited-wrapper-dead-after-free`.

**Trap:** one `body_entered` per entry (none repeated while inside); a body freed while overlapping gives ONE `body_exited` at the free and nothing later; a body moved in and freed before the physics step gives no event; the argument wrapper is dead a few frames after the free, so never store it.

## 10. Tweens and animation completion

VERIFIED. **Rule:** wait on `finished` with an interrupt finalizer that disconnects AND kills; always add a timeout.

```ts
const fade = (tween: Tween) => Effect.callback<void>((resume) => {
  let off = () => {};
  off = connectSignal(tween.finished, () => { off(); resume(Effect.void); });
  return Effect.sync(() => { off(); if (tween.is_valid()) tween.kill(); });   // interruption disconnects AND kills
});
const fadeOut = (tween: Tween) => fade(tween).pipe(Effect.timeout(2000));
```

**Leak (engine, ticket 201):** every `create_tween()` (and `create_timer()`) leaves 2 (1) engine objects until the process ends; fine for a rare fade, wrong for one per hit (see DAILY.md, pinned by `starter/tests/refcounted-leak`). **Verified by:** EP `tween-finished-as-effect`, `tween-interrupt-kills` (control `tween-interrupt-without-kill`), `tween-kill-never-emits-finished`, `tween-owner-freed-mid-tween`, `tween-callback-order`, `tween-pause-bound-stops-with-tree`. **Trap:** `kill()` NEVER emits `finished`, so a wait on a killed tween never ends; a tween whose owner is freed turns invalid and never emits; a tween follows `tree.paused` unless `set_pause_mode(2)`; a finished tween still says `is_valid()` true.

## 11. Audio as a service

VERIFIED. **Rule:** the `Audio` service owns a fixed pool of players under a parent node; tests use a recording backend.

```ts
class Game extends Node { audioLayer = Audio.layer({ parent: this, sounds: { click: "res://sfx/click.wav" }, poolSize: 8 }); }
const sfx = Effect.gen(function* () {
  const audio = yield* Audio;
  yield* audio.play("click");                                  // UnknownSound for a typo, SoundLoadFailed for a missing file
  yield* audio.play("click", { volume: 0.5, pitch: 1.2 });     // linear gain 0..4
  yield* audio.setBusVolume("Music", 0.3);                     // linear in the API, dB in the engine; UnknownBus for a bad name
});
// tests: Audio.testLayer(sounds, recordingBackend()) records every start/stop; no engine, no audio
```

**Verified by:** ES logic `Audio` group; engine `audio-pool-plays-steals-the-oldest-and-stops-all`, `audio-closing-the-scope-frees-the-pool-5-cycles-no-growth` (control `audio-an-open-scope-keeps-the-pool-alive`). **Trap:** idle player first, else the OLDEST is stolen (`stats.stolen`); build the Layer inside a Scope (a node scope), or the pool is never released; headless uses a dummy driver: assert the recorded call, not sound.

## 12. Randomness

VERIFIED. **Rule:** all game randomness comes from the seeded `Random` service; never `Math.random` in logic.

```ts
const loot = Effect.gen(function* () {
  const r = yield* Random;                                   // Random.layer(42), or a string seed; tests: Random.testLayer(1)
  const n = yield* r.int(1, 6);
  const card = yield* r.pick(["a", "b", "c"]);
  const mixed = yield* r.shuffle([1, 2, 3]);
  const drops = yield* r.fork("loot");                       // independent of how many numbers the parent drew
  const saved = yield* r.state;                              // RandomState is a Schema: put it in the save file
  yield* r.restore(saved);
  return { n, card, mixed, drops };
});
```

**Verified by:** ES `random-seed-42-gives-the-values-bun-gave-and-the-same-checksum` (111100 draws, bun equals QuickJS), `random-restore-continues-the-exact-sequence-through-JSON`, `random-fork-does-not-depend-on-how-much-the-parent-drew`, control `random-math-random-is-not-reproducible`. **Trap:** hot per-entity code may use the plain `Rng` class directly; keep the seed in the save (or `devState`) so a restart replays.

## 13. Save and load

VERIFIED as a prototype: the service lives in the test project (`tests/effect-save/src/lib/save-file.ts`), not in `starter/src/lib`; copy it to use it.

```ts
// snippet: skip - SaveFile is a prototype inside tests/effect-save/src/lib, not importable from the starter
const saves = yield* SaveFile;                          // SaveFile.layer({ version: 3, migrate })
yield* saves.save("slot1", GameState, state);           // atomic: temp file, then rename
const loaded = yield* saves.load("slot1", GameState);   // SaveNotFound on first run is NORMAL; SaveCorrupt, SaveSchemaMismatch, SaveMigrationFailed
```

**Verified by:** EV `roundtrip-save-ok`, `roundtrip-file-is-json-envelope`, `missing-file-is-SaveNotFound`, `corrupt-*`, `mismatch-is-SaveSchemaMismatch-decode`, `migrate-old-version-is-migrated-and-decoded`, `crash-old-file-is-intact-after-restart` (control `crash-a-non-atomic-writer-would-lose-the-old-file`), `concurrent-same-file-writes-do-not-interleave`, `interrupt-*`. **Trap:** convert through `Schema.toCodecJson` before touching Godot types; `-0` loads as `+0`; a 5 MB save takes about 1 s on the main thread.

## 14. Settings

VERIFIED. **Rule:** `Settings` is a typed ConfigFile: reads never fail (missing or invalid gives the default), writes are validated, `save` is atomic.

```ts
declare const applyBusVolume: (v: number) => Effect.Effect<void>;
const prefs = Effect.gen(function* () {
  const s = yield* Settings;                                               // Settings.layer({ path: "user://settings.cfg" }); tests: Settings.testLayer()
  const vol = yield* s.get("audio", "music_volume", Schema.Number, 0.8);
  yield* s.set("audio", "music_volume", Schema.Number, 0.3);               // SettingsInvalid only if the value does not encode
  yield* s.save;                                                           // SettingsIOError
  yield* s.watch("audio", "music_volume", Schema.Number, 0.8).pipe(Stream.runForEach(applyBusVolume));   // current value, then changes
  return vol;
});
```

**Verified by:** ES `settings-roundtrip-through-a-real-file` (control `settings-unsaved-value-is-not-persisted`), `settings-changes-stream-one-event-per-real-change`, `settings-corrupt-file-starts-empty-and-the-next-save-repairs-it`, `settings-save-failure-is-a-typed-error-and-leaves-no-temp-file`; applying a volume to the engine: `audio-*` bus tests. **Trap:** values are JSON text of `Schema.toCodecJson` (the file reads `music_volume="0.25"`); a corrupt file prints one engine parse error and the next save repairs it; a missing file is the normal first run.

## 14b. Config from Godot (debug flags)

VERIFIED. **Rule:** `GodotConfig.layer()` makes `Config` read the command line (`godot --path . -- --debug.overlay --level=3`), then `ProjectSettings` (`game/mode`).

```ts
const flags = Effect.gen(function* () {
  const overlay = yield* Config.Boolean("debug.overlay").pipe(Config.withDefault(false));   // Effect 4 names: Config.String, Config.Boolean, Config.Int
  const level = yield* Config.Int("level").pipe(Config.withDefault(1));
  return { overlay, level };
}).pipe(Effect.provide(GodotConfig.layer()));
```

**Verified by:** ES `config-reads-command-line-arguments-and-project-settings` (control `config-without-the-command-line-the-level-is-the-project-default`), `config-packedstringarray-is-not-iterable-so-the-source-uses-size-and-get`. **Trap:** the command line wins; only user arguments after `--` are read; a Vector2 setting reads as missing; an empty string counts as missing.

## 15. Logging and error boundaries

VERIFIED. **Rule:** edges use `runLogged` / `forkLogged`; a loop body ends in `catchCause`; an engine callback makes ONE call into a method that cannot throw.

```ts
declare const showToast: (msg: string) => void;
declare const loop: Effect.Effect<void, string>;
forkLogged(loop.pipe(Effect.catchCause((c) => Effect.sync(() => showToast(Cause.pretty(c))))), "spawn-loop");
void runLogged(Effect.log("booted"), "boot");
```

**Verified by:** EG group 4 (12 failure modes, with and without source maps; control: the run without the map must not print `.ts:line`), EC `logger`, `run-modes`, `cause`. **Trap:** bare `runFork` is silent, bare `runPromise` prints no stack, `console.error` adds a garbage `at:  (:0)` line, and `forkOnNode` does not log a failure (end its effect with `catchCause`, as in "Start here"); a throw in a callback is swallowed by the engine.

## 16. Pause and time scale

VERIFIED. **Rule:** a pause menu sets `tree.paused`; game logic runs on the game clock; menu nodes are `PROCESS_MODE_ALWAYS`. All measured while `tree.paused = true`:

| Thing | While paused |
|---|---|
| `Frames` fibers | follow the NODE's `process_mode`: inherit and pausable freeze, `WHEN_PAUSED` ticks only paused, `ALWAYS` ticks always |
| game clock | follows `tree.paused` only: a cooldown on it freezes even under an `ALWAYS` node; do not use it for pause-menu animation |
| stock Effect clock, `setTimeout`, `setInterval` | ignore pause |
| `create_timer(t, true)` / `(t, false)` | fires while paused / waits for the unpause |
| `Timer` node | pausable freezes (keeps `time_left`), `ALWAYS` fires, `Timer.paused = true` freezes any |
| `Engine.time_scale` | scales `create_timer` (4x: 0.8 s fires after 0.2 s); `ignore_time_scale = true` does not; delta is exactly 0 at scale 0 |

**Verified by:** ET `game-clock-paused`, `time-scale-wall-time`, `pause-modes`; EP `pause-frames-fibers-by-process-mode`, `pause-game-clock-follows-tree-paused-only`, `pause-default-clock-and-js-timers-ignore-pause`, `pause-scene-tree-timer-process-always`, `timer-node-pause-modes`, `timer-node-paused-property`, `tween-pause-bound-stops-with-tree`, `scene-tree-timer-time-scale`; EM (Pause, Unpause, SetTimeScale); EN `pause-freezes-spawner-and-lifetimes-pausable-ai-always-ai-ticks`, `time-scale-speeds-up-the-spawner-and-zero-freezes-the-game-clock`, controls `spawner-on-stock-clock-keeps-spawning-while-paused`, `spawner-on-stock-clock-ignores-time-scale`. **Trap:** UI animation on a pause menu must use `Frames` on the ALWAYS node, a `process_always` timer or a tween with `set_pause_mode(2)`.

## 17. Hot reload and devState

VERIFIED. **Rule:** after a live swap, a call through `this.` runs the NEW code and everything made earlier keeps the code it was made from: nothing is interrupted, duplicated or lost, and nothing is refreshed either. A closure, a fiber body, a `Stream.runForEach` callback and a service object built by a Layer in `_ready` are all "made earlier", so keep them thin (one call through `this.`) and rebuild a Layer from new code when its own closures must change. State that must survive a restart goes through `devState`.

| Made before the swap | After the swap (pinned by `tests/hot-reload` n) |
|---|---|
| a call `this.method()` from any of the below | the NEW body |
| a fiber from `forkOnNode(nodeScope(this), ...)` | same fiber, same scope, ticks 1, 2, 3, ... without a gap; its body closure is OLD (`closure=c1`), `this.` calls inside it are NEW (`method=m2`) |
| a Layer built in `_ready`; the service held in a closure and in a field | the SAME object in both places (`same=true`): the closures it was built from are OLD (`stamp()` still returns the old text), what it reaches through `this.` is NEW. Building the Layer again in new code gives a fresh object; assigning it to the field refreshes the field only, the closure keeps the old service. Both Layer scopes release on node exit |
| a `signalStream` subscription | the SAME single connection (`conns=1`): every emission arrives once, none lost or duplicated; the consumer closure is OLD |
| a pending `Effect.sleep` on the game clock | still pending (its frame hook on the tree survives), wakes on game time (4006 ms for 4000), the continuation is the OLD closure and calls `this.` NEW |
| a `SubscriptionRef.changes` or `Stream.fromPubSub` consumer fiber | the same subscription: each value once, in order; the consumer closure is OLD; new code may publish into the old store with its own Effect copy |
| the node scope | still closes on `tree_exiting`; the finalizers are the OLD closures and the fibers are interrupted (EM `HotSwap` keeps R1 to R8 true in random sequences) |
| a fiber forked by code that runs AFTER the swap | made from the NEW closure (`c2`) |

```ts
const Sim = hot("Sim", class Sim { day = 1; step(): void { this.day += 1; } });   // logic on the prototype: edits go live
class Arena extends Node {
  sim = new Sim();
  score = 0;
  wave = 1;
  _ready() {
    devState("arena", { save: () => ({ score: this.score, wave: this.wave }), load: (s: { score: number; wave: number }) => { this.score = s.score; this.wave = s.wave; } });
    forkOnNode(nodeScope(this), Effect.repeat(Effect.sync(() => this.regen()), Schedule.spaced(500)));   // closures call through this.
  }
  regen() { this.score += 1; }
}
```

A service built by a Layer in `_ready` follows the same rule: make it thin, so an edit to the logic is live without rebuilding anything.

```ts
class Wallet extends Context.Service<Wallet, { readonly pay: (n: number) => Effect.Effect<void> }>()("game.Wallet") {}
class Shop extends Node {
  coins = 10;
  pay(n: number) { this.coins -= n; }                                                  // the logic: a method, an edit is live
  _ready() {
    const ns = nodeScope(this);
    const layer = Layer.succeed(Wallet, { pay: (n) => Effect.sync(() => this.pay(n)) });   // thin: one call through this.
    const ctx = Effect.runSync(Layer.buildWithScope(layer, ns.scope));                  // built once; its scope is the node's
    forkOnNode(ns, Wallet.pipe(Effect.flatMap((w) => w.pay(1)), Effect.repeat(Schedule.spaced(500)), Effect.provideContext(ctx)));
  }
}
```

**Verified by:** `tests/hot-reload` (n) one node holding fibers, a Layer, a `signalStream`, game-clock sleeps, a `SubscriptionRef` and a `PubSub` consumer across one live swap, with (o) the same edit as a restart (every assertion of (n) must fail there) and (p) doctored logs (each sub-assertion must turn red); `tests/effect-model` command `HotSwap` (R9: the node class is re-evaluated in random sequences, no scope, fiber or connection is lost, old closures keep their generation, live nodes run the new one; control `swap-drops-hook`); `tests/hot-reload` (a) to (m) for the rest; `tests/dev-state`. **Trap:** a service object, a closure, an `Effect.gen` body and a `Stream` callback made in `_ready` keep OLD code after a swap, and a service held in a closure stays the old object even after you rebuild the Layer and assign the new one to a field; state that must survive a restart must be reachable from `save()`/`load()` (a Ref in a closure is lost); a changed state shape restarts and discards. The swap has no hook to re-run `_ready`: to give a node new services, restart (`bun run dev` does it when the shape changes) or call a method that rebuilds them.

## 18. Testing

VERIFIED. **Rule:** logic in pure functions and services with test Layers, run by `bun test` with no `godot` import; node behaviour in an engine test with a negative control.

```ts
import { describe, expect, it } from "bun:test";

describe("shooting", () => {
  it("plays the shot sound once per press", async () => {
    const t = GameServicesTest({ sounds: { shot: 1 }, actions: ["fire"] });
    const program = Effect.gen(function* () { yield* (yield* Audio).play("shot"); });
    await Effect.runPromise(program.pipe(Effect.provide(t.layer)));
    expect(t.audio.calls.filter((c) => c.op === "start").length).toBe(1);
  });
});
```

**Verified by:** ET `testclock` (25 identical `TestClock` runs, also in the engine), EC (differential against bun), ES logic tests (49 tests, 15 controls), EM `model.test.ts` (the pure model under `bun test`). **Trap:** `bun test` cannot import `godot`: keep Godot behind a service; copy `tests/effect-godot` for an engine test, and every behaviour needs a negative control.

## 19. What not to do in a hot loop

VERIFIED by CO (asserted ceilings). **Rule:** per-entity per-frame work is a plain loop; Effect starts, waits, fails.

| Do not | Cost | Do instead |
|---|---|---|
| `runSync` per entity per frame | 12 us each (batched inside one program: 2 us) | one program per frame, or a plain loop |
| `Effect.sync` around a property read | adds up | read plainly |
| thousands of fibers looping `yieldNow` | 10,000 of them give 8 fps | one fiber on `Frames` |
| a `Queue.take` loop for bulk items | keeps up with about 400 per frame | `Stream.fromQueue` or `takeAll` |
| interrupting 100k fibers at once | freezes 7.6 s (10k: 0.35 s) | close a scope per group, in chunks |

**Verified by:** CO `effect-sync-batched`, `fibers-yield-10000-frame-p50`, `pipeline-take-loop-consumer-backlog`, `pipeline-stream-consumer-backlog-at-1000-per-frame`, `fibers-10k-interrupt-all`. Table in full: `docs/design/effect-cost.md`.

## 20. Waves and spawning on a Schedule

VERIFIED (script-class nodes). Verified: `Schedule.spaced` on the game clock under pause and `time_scale`, deterministic under `TestClock`; real `Area2D` nodes spawned from the schedule (6 per wave, alternating freed and pooled), a wave complete when all are despawned (a `Ref` counter completes a `Deferred`), the next wave then starts, 20 waves in a row with the invariants checked after each. Not verified: waves of hundreds of entities, `PackedScene.instantiate` (see section 3).

```ts
const waves = (clock: Clock.Clock, wave: Ref.Ref<number>, spawn: (n: number) => void) => {
  const spawnWave = Effect.gen(function* () {
    const n = yield* Ref.updateAndGet(wave, (w) => w + 1);
    spawn(n);                                    // spawn in chunks per frame, not 500 at once
  });
  return Effect.repeat(spawnWave, Schedule.spaced(5000)).pipe(Effect.provideService(Clock.Clock, clock));
};
```

**A wave that completes.** Count every despawn path against the wave (`Ref`), complete a `Deferred` at 0, await it before the next wave. Bound the spawner with `{ schedule, times: n - 1 }`: `Effect.repeat(spawnOne, { schedule: Schedule.spaced(...), times: n - 1 })` runs n times.

```ts
import * as Deferred from "effect/Deferred";
const wave = (n: number, spawnOne: Effect.Effect<void>, onDespawn: (cb: () => void) => void) => Effect.gen(function* () {
  const remaining = yield* Ref.make(n);
  const done = yield* Deferred.make<void>();
  onDespawn(() => { if (Effect.runSync(Ref.updateAndGet(remaining, (k) => k - 1)) === 0) Effect.runSync(Deferred.succeed(done, undefined)); });
  yield* Effect.repeat(spawnOne, { schedule: Schedule.spaced(Duration.millis(40)), times: n - 1 });
  yield* Deferred.await(done);                   // all n despawned: the caller starts the next wave
});
```

**Verified by:** ET `spaced-schedule`, `fixed-schedule`, `deterministic`, `time-scale-zero`; EN `wave-completes-when-all-despawned-then-next-starts`, `wave-plan-is-deterministic-for-a-seed` (the `Random` service: same seed, same plan), `run-20-waves-invariants-after-each-wave`, `run-memory-flat-over-20-waves`, pause and scale `pause-freezes-spawner-and-lifetimes-pausable-ai-always-ai-ticks`, `time-scale-speeds-up-the-spawner-and-zero-freezes-the-game-clock` (12 spawns in 600 ms at scale 1, 48 at scale 4); controls `wave-counter-misses-a-despawn-never-completes`, `spawner-on-stock-clock-keeps-spawning-while-paused`. **Trap:** a wave counter that misses one despawn path (a hit that skips the decrement) never completes; the spawner must run on the game clock (a stock-clock spawner keeps spawning while paused and ignores `time_scale`); the spawn effect must survive a hot swap (call a method, section 17); `Schedule.fixed` can double-tick.

## 21. Services and the Layer graph

VERIFIED. **Rule:** one Layer per service, a unique string key each, merged at the root; a `ManagedRuntime` is shared by nodes and disposed on quit.

```ts
class Score extends Context.Service<Score, { readonly add: (n: number) => Effect.Effect<void> }>()("game.Score") {
  static layer = Layer.effect(Score, Effect.gen(function* () {
    const total = yield* Ref.make(0);
    return { add: (n: number) => Ref.update(total, (t) => t + n) };
  }));
}
const Base = Layer.mergeAll(Random.layer(42), Settings.layer(), Score.layer);
const rt = ManagedRuntime.make(Base);
void rt.runPromise(Effect.gen(function* () { yield* (yield* Score).add(1); }));
// on quit: void rt.dispose()
```

**Verified by:** EG `layer-acquire-release-node`, `layer-release-on-failure`, `layer-release-on-interrupt`, `layer-managed-runtime-shared`, `layer-node-scope-parent-freed` (controls `layer-without-release`, `layer-release-unguarded-queue-free`); the kit: `GameServicesLive` / `GameServicesTest` in ES. **Trap:** the key is a unique string (`"game.Score"`); each script bundle carries its own Effect copy, so share services through a `ManagedRuntime`, not through module state; a service created in a scene dies with the scene's scope.

## 22. Run scope, game over, restart

VERIFIED. **Rule:** one `Scope` per run holds the run's Layer, clock and fibers; game over closes it; then free the run's nodes and start run N+1.

```ts
const startRun = (runLayer: Layer.Layer<never>, runLoop: Effect.Effect<void>) => Effect.gen(function* () {
  const runScope = yield* Scope.make();
  yield* Layer.buildWithScope(runLayer, runScope);
  yield* Effect.forkIn(runLoop, runScope);                    // the run's fibers end with the scope
  return runScope;
});
const endRun = (runScope: Scope.Closeable, clock: GameClock, root: Node) => Effect.gen(function* () {
  yield* Scope.close(runScope, Exit.void);
  clock.dispose();
  root.get_parent()?.remove_child(root);
  root.queue_free();                                           // then await 3 frames before run N+1
});
```

**Verified by:** EP `restart-5-runs-no-stray-fibers-nodes-connections` (five runs in one process, each with a run Scope holding a Layer, a game clock, 3 fibers, 50 nodes with fibers, a Timer and a Tween: 0 live fibers, node and orphan counts at baseline, no `process_frame` connection left, no engine ERROR). Controls that prove the leaks are visible: `restart-skip-teardown-leaks-fibers`, `restart-forgot-clock-dispose-leaks-connection`, `restart-forgot-run-scope-leaks-fibers`. **Trap:** a freed Object left in a Dictionary crashes; assert `no-orphan-nodes` after the close.

## 23. Data across the Godot boundary

VERIFIED. **Rule:** convert with `Schema.toCodecJson` (or use plain numbers and strings) before anything is handed to Godot; never pass `Map`, `Set`, `Date`, `Option` or class instances.

```ts
const Save = Schema.Struct({ score: Schema.Number, seen: Schema.Array(Schema.String) });
const toGodot = Schema.encodeSync(Schema.toCodecJson(Save));       // JSON-safe value: numbers, strings, plain arrays and objects
const fromGodot = Schema.decodeUnknownSync(Schema.toCodecJson(Save));
const roundTrip = (n: Node) => { n.set_meta("save", toGodot({ score: 3, seen: ["a"] })); return fromGodot(n.get_meta("save")); };
```

**Verified by:** EB `data` (fast-check, 400 runs, engine and bun compare one digest; controls `property-detects-dropped-null`, `-damaged-strings`, `-bigint-type-loss`, `-effect-object`), `pure.test.ts`, `errors`, `lifetime`, `order`. **Trap:** int versus float is decided by QuickJS' representation, not the value; a BigInt above 2^63 wraps silently, a string with `\0` is cut, `undefined` comes back `null`; a freed Object read out of a container crashes (`lifetime`).

## 24. Soak and leak checks

PARTLY. Verified: node and orphan counts, live fibers and connections are asserted after every command of the model-based test, after every restart and after each of 20 waves of spawning and despawning real nodes; memory stays bounded over repeated runs (EN: +15 to +270 KB over 20 waves). Not verified: a game-level soak (the optional arena demo).

```ts
const counts = () => [
  Performance.get_monitor(Performance.Monitor.OBJECT_NODE_COUNT),
  Performance.get_monitor(Performance.Monitor.OBJECT_ORPHAN_NODE_COUNT),
];
// before: const base = counts();   after every restart: expect counts() to equal base (orphans too)
```

**Verified by:** EM (`World.verify`: node count, orphan count, fibers, listeners, connections after every command; controls `wrong-model`, `skip-close`), EG `no-orphan-nodes` (control `orphan-node-is-seen`), EP `restart-memory-bounded`, EN `run-20-waves-invariants-after-each-wave`, `run-memory-flat-over-20-waves`, `run-end-closes-scope-fibers-connections-and-nodes` (controls `run-end-forgot-run-scope-leaks-fibers`, `run-end-forgot-clock-dispose-leaves-connection`), ET `dispose-cycles-memory`, CO `fibers-10k-rss-growth`. **Trap:** the engine has frame spikes of 20 to 30 ms without any Effect: assert a p99 and a max, never zero.
