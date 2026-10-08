# Day to day with this project

Paths in these docs are paths in your project (`src/lib/leak-free.ts`, `docs/EFFECT.md`, `tools/plugin/options.ts`). A path that starts with `starter/` or `docs/design/`, or that a sentence places "in `godotjs-esm`", is in godotjs-esm, the development repository this template is generated from: the tests, measurements and design notes behind a rule. It is not part of your project and you never need it to use the project.

## One-time setup: where is the GodotJS binary?

```sh
bun tools/config.ts set /path/to/godot.macos.editor.universal   # global: every project on this machine uses it
bun tools/config.ts show                                        # what is configured, and where it came from
```

Resolution order: `GODOTJS` in the environment, then the global config (`~/.config/godotjs/config.json`). The environment can be the shell (`export GODOTJS=...`, handy for CI or a one-off) or a `GODOTJS=/path/to/binary` line in the project's `.env`, which Bun loads for every `bun run` and `bun tools/...` command (`.env` is gitignored, so it stays on this machine). `bun tools/config.ts` itself writes only the global file. For clickable TypeScript errors and mapped error positions in the editor, point it at the patched editor build (`bin/macos-editor-4.6.1-qjs-ng-clicklink/` in the `godotjs-esm` repo); the stock release works for everything else.

## In Cursor / VS Code

`.vscode/settings.json` points the editor at the project's own TypeScript, and `.vscode/tasks.json` has tasks for the watch build, the Godot editor and the type-check (Terminal > Run Task). For full Godot API autocomplete run `bun run types` once (about 6 MB), then **Cmd+Shift+P, "TypeScript: Restart TS Server"** and accept "Use workspace version" if asked.

**Rerun `bun run types` after a Godot upgrade AND after you change the input actions (InputMap), autoloads or other `project.godot` settings.** The typings carry your action names, so after adding `move_left` to the InputMap `Input.get_vector("move_left", ...)` fails the type check with `Argument of type '"move_left"' is not assignable to parameter of type 'InputActionName'` until you regenerate. `bun run build` and a failing `bun run typecheck` print a ``hint: input action(s) ... run `bun run types` `` line when `project.godot` has actions the generated typings lack (autoloads and other settings are not checked). `bun run types` ends with engine exit noise even when it works (`RID allocations ... leaked at exit`, `resources still in use at exit`, `undefined class AnimatedValuesBackup`); its last line, `typings OK ...`, is the verdict.

## The loop

```sh
bun run dev:build      # terminal 1: rebuilds on save (leave it running)
bun run editor         # terminal 2: the Godot editor; press F5 to play
```

Edit in your editor of choice and save. In Godot, press F5 again to run the new code (F5 games never hot-swap; the `hot_reload` addon refreshes the editor's view of scripts without needing window focus). No editor? `bun run dev` rebuilds on every save and swaps edited script classes into the running game, or relaunches it when it cannot (see Hot reload below). State you register with `devState("name", { save, load })` (`src/lib/dev-state.ts`) survives that relaunch, so a ticking sim keeps its day and hour; a changed shape is discarded with a `dev-state:` line, and `bun run dev --fresh` starts from scratch every time.

Other scripts: `bun run build` (one build), `bun run start` (run the game), `bun run headless` (run without a window, quits after 300 frames; arguments for YOUR game need a second `--`: `bun run headless -- -- --autoplay`, because `bun run` eats the first one and Godot silently takes a lone `--autoplay` as an engine option), `bun run headless:mapped` (same, with stack traces mapped to `src/...`), `bun run types` (generate real Godot typings; `bun run types:shim` goes back to the stub), `bun run typecheck`, `bun run test` (logic tests, no Godot), `bun run test:engine` (engine tests, headless Godot; see Testing your game), `bun run export:macos` (release `.app` in `out/`, then a pack check, a headless run of the release app and a debug-build log check; needs the export templates once, see `docs/SHIPPING.md`; `--expect "text"` asserts a log line, `--game-args "--autoplay"` passes arguments to your game in both runs, `--no-smoke` skips running the app).

## Hot reload (`bun run dev`)

`bun run dev` swaps edited script classes into the RUNNING game: instances stay alive, `_ready` does not re-run, fields and `@gd.export` values keep their values, a timer keeps counting. About 0.3 s from save to swap. It needs one line in your main scene root's `_ready`: `hotReload()` (`import { hotReload } from "./lib/hot-reload"`, already in the starter's `src/main.ts`). It does nothing outside `bun run dev` (no timer, no file access without the `GODOTJS_DEV_STATE` variable the runner sets), so exports and `bun run start` are unaffected.

**Which scene a relaunch starts in.** A relaunch (below) starts in the scene that was running, not in the main scene: a restart-class edit while you play the game scene does not drop you back at the menu (the game's save records `current_scene.scene_file_path`; the runner prints `dev: launching res://...`). `bun run dev --scene res://scenes/game.tscn` starts the first launch there too; `bun run dev --main-scene` always starts at the main scene (use it when the game scene only works after the menu has set something up). Engine and game arguments for every launch go in `GODOT_ARGS` (split on spaces, appended after `--path .`; game arguments after a `--`): `GODOT_ARGS="--headless --fixed-fps 60 -- --autoplay" bun run dev`.

**A game with several scenes** (a menu as the main scene, the game in a second one). `hotReload()` installs ONE poller for the whole process, so the call in the main scene keeps working after `change_scene_to_file` and `reload_current_scene`. Also call it in the root `_ready` of every scene you may START in (a relaunch into that scene, `--scene`, or F6 in the editor; a second call only replaces the handler). The same goes for the polyfill: put `import "../polyfills/web-globals.js";` (with the right number of `../`) first in every script that imports Effect, directly or through `src/lib/`. Every script is its own bundle, the polyfills install their globals once per process, and which script the engine loads first depends on the scene, so each script must be able to go first; an extra copy costs bundle size only (each polyfill skips a global that already exists). Dev runs, `bun run test:engine` and export checks use the same `user://` folder as the player (`app_userdata/<Project Name>/`), so an autoplay or soak run overwrites a saved best score; give tests and autoplay runs their own file (`Settings.layer({ path: "user://test.cfg" })`, chosen from a command-line flag).

What reloads in place: method and virtual bodies (`_process`, `_ready`-for-new-instances, ...) of a script class, new methods, callables made by name (`Callable.create(this, "onPing")`), anything a closure calls through `this.`, and NEW exports and `accessor` fields: add `@gd.export() accessor speed: number = 3` or `accessor bonus = 0` and the live instance reads `3` / `0` at once (the swap runs the new class' initialisers once on a throwaway instance and hands those values to live instances on first use; so a constructor side effect of the new class happens one extra time). Plain classes wrapped in `hot()` (below).

**The rule, in one sentence:** an edit is live only in a script class or in a module that registers a class through `hot()`; when you change any other module under `src/` (a plain class or function, say `src/lib/sim/*.ts`) the runner does not pretend: it prints `hot reload: restart needed (plain module changed: src/lib/sim/x.ts)` and relaunches with `devState`, so the edit is always applied (a module counts as covered when it contains a `hot("Name", ...)` call; other classes and functions in that same module are not tracked, keep one concern per module).

What falls back to the existing restart-with-state (the runner does it for you, `devState` comes back): an export REMOVED or changed type, a plain class field ADDED (`count = 0` without `accessor`: live instances would keep it `undefined`; the runner prints `field added: count`),  a signal or the base class added, removed or changed; an engine virtual (`_physics_process`, `_input`, ...) added or removed; a module that throws while evaluating (the log shows the throw; fix it and save, the next relaunch recovers, and state saved before the throw comes back: a key the broken process never registered is kept, not dropped); a plain module changed (above); a `hot()` class whose data shape changed (`state shape of Sim changed`: a field added, removed or retyped in what its constructor builds, nested state included); a game that does not answer within 1.5 s. The runner prints `hot reload: restart needed (...)` first. `bun run dev --no-hot` (or `GODOTJS_DEV_HOT=0`) always restarts.

Memory: the engine keeps every old version of a swapped module (ticket 302). A script that imports Effect costs about 0.5 MB per swap (200 swaps: +100 MB), a script without Effect almost nothing. After a few hundred swaps in one session, stop and restart `bun run dev` (state comes back through `devState`).

### The thin closure rule

A closure keeps the OLD code. `connect(fn)` lambdas, `setInterval(fn)`, `Effect.runFork` fibers and `Effect.repeat` bodies capture the function body at creation, so editing that body changes nothing until the next restart. Keep every closure to one call into a method; the method is looked up on the live object each time, so editing it is live. The same goes for everything built once in `_ready`: a Layer's service object, a `signalStream` or `Stream.runForEach` callback, a game-clock sleeper's continuation. A swap keeps all of them running (nothing dropped, nothing delivered twice) with their old code; see `docs/EFFECT.md` section 17 for the table.

```ts
// snippet: skip - two versions of the same method side by side, not one compilable file
// Stale after a swap: the body is captured when _ready runs, editing it does nothing.
_ready(): void {
  setInterval(() => { this.hp -= 1; console.log(`poison, hp=${this.hp}`); }, 1000);
  this.hit.connect((dmg) => { this.hp -= dmg * 2; });
  Effect.runFork(Effect.repeat(Effect.sync(() => { this.hp += 1; }), Schedule.spaced(500)));
}

// Live after a swap: closures only call through `this.`; the logic is in methods.
_ready(): void {
  setInterval(() => this.poison(), 1000);
  this.hit.connect((dmg) => this.onHit(dmg));
  Effect.runFork(Effect.repeat(Effect.sync(() => this.regen()), Schedule.spaced(500)));
}
poison(): void { this.hp -= 1; console.log(`poison, hp=${this.hp}`); }
onHit(dmg: number): void { this.hp -= dmg * 2; }
regen(): void { this.hp += 1; }
```

Edit `poison` to `this.hp -= 2` and save: the next tick (still the same interval, same node, same `hp`) uses the new body. A removed method called from a stale closure throws `not a function` in the timer. Same rule for values computed once in `_ready` (a cached node, a connection): they do not re-run, restart to see them change. A hand-written long closure is not rewritten or warned about; the discipline is yours.

### Plain classes: `hot(name, cls)`

Script classes swap by themselves. A plain logic class (no Godot base, say `src/lib/sim/`) does not: re-evaluating the bundle creates a new class object while the old instances keep the old prototype. Wrap the class once and its instances keep their data and run the new method bodies:

```ts
import { hot } from "./lib/hot";

export const Sim = hot("Sim", class Sim {
  day = 1;
  step(): void { this.day += 1; }   // edit this body: the existing Sim instance runs the new one
});
```

Rules: one unique name per class, and import the class from one script bundle; no `#private` fields or `accessor` inside a hot class (use `private`); statics are not carried over; a field you ADD (or remove, or retype) changes the data shape: the swap builds one throwaway instance of the old and of the new class and compares their data (keys and value types, what `devState` compares), and asks for the restart, so live state is never missing the new field (a class that cannot be built without arguments is not checked; the constructor of the throwaway instances runs once more each, so keep constructors free of timers and subscriptions). Outside a reload `hot()` is a Map lookup at class definition. `src/lib/hot.ts` is a toolchain file (updated with `tools/update.ts`).

#### A `hot()` class must keep its logic on the prototype

`hot()` re-points old instances at the NEW prototype. That swaps every prototype method, and nothing else: a function that was built in the constructor (an arrow function assigned to a property, or inside an object literal such as a `store`) was made from the OLD code and every module-level helper it calls keeps the old module's bindings. Edit it and the runner says swapped, the new text never runs.

```ts
// snippet: skip - stale and live version of the same class side by side, not one compilable file
// Stale after a swap: `dispatch` is an arrow built in the constructor (old code), and so is everything it calls.
export const Sim = hot("Sim", class Sim {
  state = { day: 1, log: [] as string[] };
  store = {
    dispatch: (e: string): void => {          // edit this body: nothing changes
      this.state.day += 1;
      logTransition(this.state, e);          // and logTransition() stays the old function it was bound to
    },
  };
  step(): void { this.store.dispatch("tick"); }   // live, but it calls the stale closure
});

// Live: the logic is a method; the closure (or object literal member) only forwards to it.
export const Sim = hot("Sim", class Sim {
  state = { day: 1, log: [] as string[] };
  store = { dispatch: (e: string): void => this.doDispatch(e) };
  doDispatch(e: string): void {               // looked up on the live object each call: new body, new helpers
    this.state.day += 1;
    logTransition(this.state, e);
  }
  step(): void { this.store.dispatch("tick"); }
});
```

How to restructure: move the body into a method, leave a one-call forwarder where an API needs a property (`dispatch: (e) => this.doDispatch(e)`), and do the same for `connect`, `setInterval` and `runFork` callbacks. Same rule as the thin closure rule above, extended to "whatever the closure calls": the helper is reached through the method, which is on the new prototype. Measured (the dogfood notes in `godotjs-esm`, scenario 8): the edited `dispatch` body printed in 0 of 14 ticks as a constructor arrow and in 6 of 6 after moving it to a method. There is no build warning for this (the plugin only has errors, no warning channel; a check for arrow properties would also hit the many classes that are not hot).

Other limits: a comment-only edit still re-evaluates the bundle (dev builds rename identifiers, so the bytes change), which is harmless. Rule: state that must survive AND may be added later is an `accessor` (`accessor field = 0` swaps in live with its default); adding a plain `field = 0` to a script class restarts with `devState` instead, never a silent `undefined`. The check compares the own fields of a throwaway instance before and after the swap, so a field first assigned only in `_ready` or another method is not noticed, and removing a plain field does not restart. A script class that cannot be built without arguments is not checked. `devState` may be called from any script bundle (the library copies share one registry and one state file). Design, evidence, unverified list: `docs/design/hot-reload.md` in `godotjs-esm`.

Errors in `bun run dev`: in a terminal the runner pipes the game's output through `tools/unmap.ts`, so a step error reads `at step (src/lib/sim/sim.ts:295:38)` instead of a bundle position on the stock engine too. `bun run dev --raw` (or `GODOTJS_DEV_RAW=1`) prints the engine's lines untouched; with output redirected to a file or a pipe nothing is mapped (set `GODOTJS_DEV_UNMAP=1` to map anyway). The engine's colours are lost when mapping is on (the output is a pipe to the runner).

## Time: timers, `Effect.sleep` and game time

**Which clock** (details below):

| You need | Clock | How |
|---|---|---|
| real seconds that pause must NOT stop: a UI fade, a timeout on a load, a "press again within 300 ms" | wall (the default) | `setTimeout`, `Effect.sleep`, `Schedule.*` with no clock provided |
| gameplay time that freezes on pause and follows `time_scale`, in normal windowed play only | game | `makeGameClock(tree)` (`src/lib/game-clock.ts`), `clock.dispose()` when its node leaves |
| the same, and reproducible: headless tests, `--fixed-fps`, replays, soak runs, a GDScript twin; repeating timers that must not drift | frame | `makeFrameClock()` (`src/lib/frame-clock.ts`), `clock.advance(delta)` in `_process`, `clock.timer(ms)` for a repeat |

When unsure, pick the frame clock: it counts what Godot's own `Timer` nodes count, and it is the only one that is exact under `--fixed-fps` (the cookbook's tiny game loop uses it).

Opt-in accuracy: the 10% lateness is the engine's timer wheel dropping the sub-millisecond part of every frame. One line after the `web-globals.js` import fixes most of it for timers of 40 ms or more: `import "../polyfills/timer-accuracy.js";`. Measured (stock binary, wall clock): uncapped 9.8% late becomes 2.9%, 120 fps 5.8% becomes 3.5%, `setInterval` drift over 2 s goes from 125 to 215 ms down to under 15 ms, and a timer never fires early. At 60 fps the mean lateness stays about 5% (a callback waits for its frame, half a frame on average, which no timer code can remove) and `Schedule.spaced` totals get slightly longer, because stock fires some gaps early. Cost: one extra native timer per second and about 2 per 3 long timers. Not default; `setTimeout`/`setInterval` return a small handle object that `clearTimeout`/`clearInterval` accept. Details: `docs/design/effect-time.md` in `godotjs-esm`.

`setTimeout`, `setInterval` and `Effect.sleep` / `timeout` / `Schedule.*` all run on the engine's wall clock, about 10 ms granular and about 10% late (a 200 ms sleep took 215 to 230 ms; measure with generous windows, never exact ms). They are NOT game time: `SceneTree.paused = true` does not stop them and `Engine.time_scale` does not stretch them (measured: a 200 ms sleep took about 220 ms under both). Interrupting a sleeping fiber (`Fiber.interrupt`, losing a `race`, a `timeout`) stops it at once; `runFork` and `forkDetach` fibers keep going; pending timers and fibers never keep the game from quitting. `polyfills/web-globals.js` holds timers armed in the first frame (`_ready` of the main scene) until the engine's timer wheel has run once; without that, a timer shorter than the engine's start-up time fires at once.

If a cooldown or a `Schedule` should freeze while the game is paused and follow `time_scale` (Effect projects only: `src/lib/game-clock.ts` is not in the `--no-effect` template), opt in per program:

```ts
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { makeGameClock } from "./lib/game-clock";

declare const program: Effect.Effect<void>;
class Arena extends Node {
  _ready() {
    const clock = makeGameClock(this.get_tree());
    Effect.runFork(program.pipe(Effect.provideService(Clock.Clock, clock)));  // sleep, timeout, repeat, retry now run on game time
    // when the owning node leaves the tree: interrupt its fibers, then clock.dispose()
  }
}
```

Game time advances once per frame (wall delta x `time_scale`, nothing while paused), so it is frame-accurate, not ms-accurate. Plain `setTimeout` / `setInterval` stay on wall time. `create_timer(sec)` already follows pause (pass `process_always = false`) and `time_scale`, if you only need one callback. Details, numbers and the decision: `docs/design/effect-time.md` in `godotjs-esm`; test: `starter/tests/effect-time`.

`makeGameClock` follows WALL time times `time_scale`. It is the wrong clock for anything that must be reproducible: under `--fixed-fps` (a headless test, a replay, a comparison with a GDScript twin) every frame is a fixed `delta` but lasts far less than that on the wall, so the game clock hardly moves and a 2 s start timer never ends. For those, use `src/lib/frame-clock.ts` (Effect projects only): `makeFrameClock()`, call `clock.advance(delta)` from `_process(delta)`, and it counts exactly what Godot's own `Timer` nodes count (pause and `time_scale` come for free, the engine already scales and stops `delta`). Its `clock.timer(500)` is the repeating schedule a Godot `Timer` is: `Schedule.spaced` on a frame clock drifts one frame per cycle (a 0.5 s timer fires every 31 frames at 60 fps instead of 30) because it re-sleeps the full wait from the wake-up frame; `timer` carries the overshoot. Test: `starter/tests/frame-clock` (against a literal copy of the engine's arithmetic, with a `Schedule.spaced` control).

### Engine-returned objects leak (engine defect: timers, tweens, input events, collisions)

**The rule.** A `RefCounted` the engine hands to your script is never freed (until the game exits) when the engine still holds it somewhere else at that moment. One object per call, invisible to node, orphan and exit-leak checks, visible in `Performance.OBJECT_COUNT`. GDScript frees all of these. What leaks today:

| You write | Leaks per call | Leak-free form |
|---|---|---|
| `get_tree().create_timer(t)` | 1 | `setTimeout`, `Effect.sleep`, `FrameClock.sleepCounting`, or a one-shot `Timer` node |
| `create_tween()...` | 2 (tween + each tweener) | `tweenProperty(node, "path", to, sec, done?)` from `src/lib/leak-free.ts`; an `AnimationPlayer`; animate in `_process` |
| `_input(event)`, `_unhandled_input(event)` on a script class (`_gui_input`, `_shortcut_input`: same path, not measured) | 1 per event (every key, mouse move, joypad axis) | `onInputEvent(this, (ev) => ...)` from `src/lib/leak-free.ts` (hands you a copy; drop the method); or poll `Input` in `_process` |
| `get_slide_collision(i)`, `get_last_slide_collision()`, 2D and 3D | 1 (2 per frame in a typical 3D controller, about 7 KB) | `slideCollisions(body)` from `src/lib/leak-free.ts` (plain `{ collider, normal, position, angle }`) |
| `move_and_collide(v)` that hits, 2D and 3D | 1 | `body.test_move(body.global_transform, v, kc)` with ONE `new KinematicCollision3D()` you keep and reuse (then move yourself) |
| `AudioStreamPlayer3D.get_stream_playback()` after each `play()` | 1 per play | none: each `play()` makes a new playback, so read it only when you need it (a generator: once per `play()`) |
| a signal or `Callable` from GDScript whose argument is held in two places | 1 | pass a copy (`.duplicate()`) or a plain value |

Not leaking: objects you create (`new RefCounted()`, `new KinematicCollision3D()`), objects the engine gives away (`FileAccess.open`, `PhysicsRayQueryParameters3D.create`, `Image.create`), the same long-lived object read again (`node.mesh`; it only stays alive after its owner drops it).

**The build warns** at each `create_timer`, `create_tween`, `get_slide_collision` and `get_last_slide_collision` call (switch `leakCalls`) and at each `_input` / `_unhandled_input` method on a class that extends a Godot class (switch `inputVirtuals`), naming the leak-free form. A file that leaks on purpose (a menu fade you accept, a test) opts out with a comment anywhere in it: `// godotjs-plugin-allow: leakCalls inputVirtuals`. Not warned: `move_and_collide`, `get_stream_playback`, a signal argument held twice (no fixed spelling to catch).

**What does not help:** `obj.unreference()` (it does not free, it leaves the object with a count of -1 that the engine reports at exit; on an object you created it aborts, ticket 82), dropping your variable, or forcing the JS collector: the binding holds the object strongly. A tween per menu fade or per level costs nothing; one per bullet, per hit or per frame does. Measure with `src/lib/soak-probe.ts`. `src/lib/leak-free.ts` is opt-in (copy it into your game). `starter/tests/leak-family` pins every row but the audio one (the pins fail on purpose when an engine fix lands, and this section goes); mechanism and the one-line engine fix: `docs/design/leak-family.md` in `godotjs-esm`.

**Never pass `clearTimeout` / `clearInterval` a number you did not get from `setTimeout` / `setInterval`** (a counter, `h + 1`, an id from a fake clock or another timer library, `1`). A timer handle is a packed number (slot << 20 | revision); a foreign number that equals the packed value of a FREE slot of the engine's timer table frees that slot a second time, and the next `setTimeout` aborts the whole process with `FATAL ... jsb_sindex.h:28` (exit 134, no JS error to catch). `0`, `null`, `undefined`, `NaN`, a huge number and clearing a real handle twice are all harmless; so is everything Effect does (`sleep`, `timeout`, `race`, `Stream.tick`, `Schedule`, interrupts: 14,000 timers, 0 foreign clears). Keep your own cancel token (a Set of what you armed, or the handle itself) and never turn a counter into a handle. A second limit: about 16,300 timers DUE IN THE SAME TICK overflow the QuickJS handle stack (`FATAL ... jsb_quickjs_isolate.h:397`, then the game hangs); 16,000 due at once and 40,000 spread over one second are fine (100,000 spread over a second were not: a stalled frame makes them all due together), so spread bulk timers (stagger the delays) or use one `_process` loop for thousands of things. `starter/tests/engine-abort` pins both: when an engine update fixes one, that test fails on purpose and its rule goes.

## Web APIs available

The reference is Bun: code written for Bun's host API should run here when the API is in this table. The engine is QuickJS-ng, which lacks a few web globals; small guarded polyfills (each is skipped when the global already exists) fill the pure-JS ones. Every polyfill is tested against plain Bun on fixed cases and on property runs (`starter/tests/bun-parity`, report in `docs/design/bun-parity.md` in `godotjs-esm`).

| API | Status | What to do |
|---|---|---|
| `TextEncoder`, `TextDecoder`, `AbortController`, `AbortSignal`, `EventTarget`, `setImmediate`, `crypto.getRandomValues`, `Symbol.dispose`, `Symbol.asyncDispose`, `global` (alias of `globalThis`, as in Node and Bun) | built in (`polyfills/web-globals.js`, imported first in `src/main.ts`) | nothing. `using` and `await using` work, and a class may declare `[Symbol.dispose]()` |
| `queueMicrotask`, `performance.now`, `atob`, `btoa`, timers, `console.log/warn/error` | the engine has them; tested equal to Bun | nothing. `console.table/group/dir/count` do not exist (calling them throws) |
| `URL`, `URLSearchParams` | opt-in, `polyfills/url.js` (about 19 KB minified, 6.5 KB gzip) | `import "../polyfills/url.js";` once, before the first use. `res://` and `user://` parse as URLs (`new URL("res://scenes/main.tscn").pathname` is `/main.tscn`) |
| `structuredClone` | opt-in, `polyfills/structured-clone.js` (about 4.6 KB minified, 1.6 KB gzip) | `import "../polyfills/structured-clone.js";` once. Clones objects, arrays, Map, Set, Date, RegExp, typed arrays, ArrayBuffer, BigInt, Error, cycles; throws `DataCloneError` for functions and symbols. Deep nesting is safe (it does not recurse) |
| `WebAssembly` | missing, no polyfill possible | QuickJS-ng has none (Bun and JavaScriptCore do). Do not depend on it; a game that needs it needs an engine with it |
| `Intl` (`NumberFormat`, `DateTimeFormat`, `Collator`, `PluralRules`, `ListFormat`, `RelativeTimeFormat`), and `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` / `localeCompare` that honour locale and options | opt-in, `polyfills/intl.js` (about 82 KB minified, 20 KB gzip; the largest polyfill, import it only when you format for a locale) | `import "../polyfills/intl.js";` once, before the first use. It replaces the engine's own `toLocale*` and `localeCompare`, which ignore their arguments (`(1234.5).toLocaleString("de-DE")` is `1234.5` without it). Output is Bun's: about 64,000 supported calls are tested identical to Bun (`starter/tests/intl`). **Locales: en-US, en-GB, de-DE, fr-FR, he-IL, ja-JP** (and en, de, fr, he, ja); any other locale falls back to en-US and `supportedLocalesOf` leaves it out. **Time zones: UTC, GMT and fixed offsets (`"+02:00"`) only; any other name (`"Europe/Berlin"`) throws `RangeError`**, there is no tz database. With no `timeZone` the engine's local time is used (the local zone's name is unknown: `timeZoneName: "short"` throws there, `"shortOffset"` works). Unsupported options throw `RangeError` instead of answering wrongly: units, scientific and accounting number formats, compact notation outside English, `currencyDisplay: "name"`, eras, `dayPeriod`, other calendars and numbering systems, collator `usage: "search"`, a few odd date field combinations. Not there at all: `Segmenter`, `DisplayNames`, `Locale`, `formatRange`, collation tailorings (Swedish å...), time zone names. Cost per call in the engine: about 10 to 25 us to format, 1 to 2 us per `localeCompare` |
| Effect `DateTime` named zones (`setZoneNamed`), `Cron` with a zone | missing, even with `intl.js` | they need a time zone database; `DateTime` in UTC or a fixed offset works |
| `fetch`, `process`, `Buffer`, `Blob`, `FormData` | missing | not planned: nothing in a game needs them (use Godot's `HTTPRequest`, `FileAccess`) |

The opt-in files are not in the default bundle: a game that does not import them pays nothing (the bundle hashes in `starter/tests/bundle-baseline.json` prove it). Known differences from Bun (each listed with its reason in `docs/design/bun-parity.md`): `BigInt.asUintN(64, -1n)` returns `-1n` on QuickJS-ng (an engine bug, not worked around: mask with `& 0xFFFFFFFFFFFFFFFFn` instead), `Symbol.keyFor(Symbol.dispose)` is `"Symbol.dispose"` (Bun: `undefined`), `URL` hosts are approximated for non-ASCII names, and `structuredClone` has no `transfer`.

## JavaScript differences from Bun/Node in the engine

The engine is QuickJS-ng. About 800 small language and built-in cases (BigInt, Date, number formatting, strings, RegExp, JSON, Proxy, classes) run in Bun and in the stock engine under four time zones, and everything not listed here is identical. The listed differences are pinned by `starter/tests/js-semantics` in `godotjs-esm` (a pin fails when an engine update fixes the difference, so this list stays honest). Each rule has its workaround:

- **Comparing a negative decimal with a negative BigInt is wrong** (`-0.5 > -1n` is false, `-1.5 < -2n` is true; so is `-1e21 < -2n`). Flip both signs so the positive path runs (`-0.5 > -1n` is `0.5 < 1n`), or compare as `Number(big)` when the BigInt is small. Mixed signs and positive pairs are right. Ticket 220.
- **Local time is an hour off on DST-change days in zones east of UTC** (Israel, Europe east of London, Sydney): `new Date(y, m, d, h)`, `setHours(0,0,0,0)`, `getHours()` around the switch. Date-fns style "start of day" loops can spin forever there. Keep game logic in UTC (`Date.UTC`, `getUTC*`, `setUTC*`) and only format local time for display. Tickets 223, 276.
- **A plain CommonJS file loaded with `require` runs in strict mode** (under Bun it is sloppy; your own `.ts` is strict in both): an assignment to an undeclared name throws, `this` of a plain function call is `undefined`, `arguments` does not alias parameters. Declare variables (`let`/`var`); never depend on a global `this`. Ticket 221.
- **There is no `Intl`, and `toLocaleString`, `toLocaleDateString`, `localeCompare` and `toLocaleUpperCase` ignore the locale and every option** (even `timeZone`): numbers print without grouping, `localeCompare` is code-unit order (`"a".localeCompare("B")` is 1; sort names with your own comparer), a Date prints in the machine zone. Format by hand; compare with `a < b ? -1 : a > b ? 1 : 0` or a lower-cased key. Ticket 271.
- **Three RegExp features are missing**: duplicate named groups `(?<a>x)|(?<a>y)`, `v`-flag set operations (`[\p{L}&&\p{ASCII}]` silently answers wrongly), inline modifiers `(?i:a)`. A regex LITERAL using one fails the whole script at load (`duplicate group name`, no line number). Use separate group names and the `u` flag. Everything else tested works (lookbehind, named groups, `\p{...}`, sticky, `d`). Ticket 272.
- **`{ ..."text" }` gives `{}`** (object spread of a string). Use `Object.assign({}, text)`, or do not spread strings. Ticket 273.
- **`new WeakRef(makeValue()).deref()` is `undefined` at once** when nothing else holds the value. Keep the value in a local variable until you are done with it. Ticket 274.
- **Error messages have their own wording** (`cannot read property 'x' of null`, `not a function`, `invalid number of digits`): never match on `e.message`; match on `e.name` or `instanceof`. Error names, `cause`, `stack` presence and `AggregateError` are the same.
- **Small ones**: `[a].push(a)` then `String(a)` throws RangeError for a cyclic array; `(1e300).toString(36)` loses precision after ~11 digits; `RegExp.$1` is `undefined`; `Object.prototype.toString.call(globalThis)` is `[object global]`. Ticket 275.

Same as Bun (checked, no rule needed): BigInt arithmetic and conversions, `toFixed`/`toPrecision`/`toString(radix)` on normal numbers, `parseInt`/`parseFloat`/`Number()` edge cases, stable `Array.prototype.sort`, `normalize`, `padStart`, `replaceAll` with `$&`/`` $` ``/`$<name>`, JSON edge cases, labelled statements, getters/setters, Proxy and Reflect, private class members, generators, ES2023 array methods.

## Effect with Godot nodes

Effect projects only: `src/lib/godot-effect.ts` is opt-in glue (it is not in the `--no-effect` template and not a toolchain file, so `tools/update.ts` never touches it). It gives you `signalOnce` / `signalStream` (a signal as an Effect or a Stream, interruption disconnects), `nodeScope` + `forkOnNode` (a Scope closed when the node leaves the tree, its fibers interrupted first), `Frames` (fibers that wait on `_process` / `_physics_process`), `freeNode`, `runLogged` and `forkLogged`.

```ts
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { forkOnNode, nodeScope, signalStream } from "./lib/godot-effect";

class Player extends Node {
  button!: Button;
  _ready() {
    const ns = nodeScope(this);                                    // closes when this node leaves the tree
    forkOnNode(ns, signalStream(this.button.pressed).pipe(         // fiber owned by the node
      Stream.runForEach(() => Effect.log("pressed"))));
    // a program whose failure you must SEE: forkLogged(program) instead of Effect.runFork(program)
  }
}
```

Rules, each one measured (`starter/tests/effect-godot`; `docs/design/effect-in-godot.md` in `godotjs-esm`):

- A failing `Effect.runFork` that nobody joins is completely silent. Use `forkLogged(effect)`; it prints the pretty cause.
- An unhandled `Effect.runPromise` rejection prints only `unhandled promise rejection: <name>`: no stack, and a `TaggedError` loses its fields. Use `runLogged(effect)`. Both print a line starting `ERROR [effect] ... failed:` through `console.log` on purpose: `console.error` adds a garbage `at:  (:0)` line and an `ERROR:` line. The stack has `.js:line` positions that `bun tools/unmap.ts` turns into `.ts:line`.
- Free nodes with `freeNode(node)`, not `node.queue_free()`: a raw `queue_free()` on an already freed node throws `Bad this`. Use it in Layer release functions.
- A node that never entered the tree never emits `tree_exiting`, so its `nodeScope` never closes. Close it by hand (`ns.close()`).
- `reparent()` to a DIFFERENT parent (or remove_child + add_child) emits `tree_exiting` and closes the scope, so a node that moves loses its fibers. Do not use `nodeScope` on a node you reparent. `reparent()` to the SAME parent is a no-op: nothing is emitted and the scope stays open.
- `queue_free()` does not stop a per-frame fiber at once: the node is deleted at the end of the frame, and where the engine's job drain falls in the frame varies, so a fiber on that node's `nodeScope` may tick one more time (or not) before the scope closes. Make a tick after `queue_free` harmless (read plain fields, not the node), or stop now with `ns.close()`, interrupting the fiber, or `free()`.
- Touching a signal of a freed emitter (`is_connected`) prints an engine `ERROR: Parameter "obj" is null`. The helper's disconnect checks `is_instance_valid` first; do the same in your own cleanup.
- Every interrupted `Effect.sleep` prints one `[jsb][Debug] timer active (invalid)` line in a debug build. Harmless.
- A handler that disconnects itself leaks about 0.5 KB plus its closure each time (engine defect, ticket 300): use `connectSignal(sig, fn, true)` (one-shot) or `CONNECT_ONE_SHOT`, never `sig.disconnect(c)` inside `c`. `nodeScope` and `signalOnce` already do.
- `Effect.runSync` of a real effect keeps about 0.8 KB, and each `forkOnNode` fiber about 1.7 KB, for the rest of the process (QuickJS, ticket 301). Fine for setup code; not per frame or per bullet. Prefer `runFork` in hot paths and measure with a soak (below).

## Game services kit (Effect projects)

`src/lib/services/` is an opt-in set of small Effect services (not a toolchain file, deleted by `--no-effect`): `Settings` (ConfigFile in `user://`, Schema-typed, atomic save, a change Stream), `Input` (a Stream of action events fed from one node through `onInputEvent`), `Assets` (`ResourceLoader` with a cache and a safe threaded load), `Audio` (an AudioStreamPlayer pool and bus volume), `Random` (seeded and restorable) and a `ConfigProvider` over the command line and ProjectSettings. Import from `./lib/services`; each has a live Layer and a test Layer.

```ts
import { GameServicesLive, GameServicesTest, makeInputBridge } from "./lib/services";
import { onInputEvent } from "./lib/leak-free";
class Game extends Node {
  input = makeInputBridge(["jump", "fire"]);
  layer = GameServicesLive({ input: this.input, audio: { parent: this, sounds: { click: "res://click.wav" } }, seed: 42 });
  _ready() { onInputEvent(this, (ev) => this.input.handle(ev)); } // never an _input method: it leaks one engine object per event
}
// the audio pool needs a Scope: build the Layer with Layer.buildWithScope(layer, ns.scope) from a nodeScope
// tests (bun test, no engine): const t = GameServicesTest({ seed: 1 }); program.pipe(Effect.provide(t.layer)); t.input.press("jump");
```

Rules: no `Math.random` in game logic (take `Random`); a settings value that no longer decodes gives its default, never an error; a missing asset path is `AssetNotFound` and costs no engine error lines; input arrives one frame late; `Input.events` sees only events after it runs, use `subscribe` to not miss any. The cookbook (`docs/EFFECT.md` sections 2, 7, 11, 12, 14) names the test behind every rule.

## Effect imports and upgrades

Import Effect by subpath, one namespace per module: `import * as Effect from "effect/Effect"` (same for `Layer`, `Context`, `Schema`, `Schedule`, `Clock`, `Stream`, ...), never `import { Effect } from "effect"`. Code reads the same (`Effect.sleep`, `Effect.gen`, `Layer.succeed`). Why: Bun keeps the barrel's unused modules, so a barrel import makes every script bundle 2.4x to 3.9x bigger (the starter's own imports: 480 KB vs 136 KB). The build warns at every barrel import (`[tooling] ... imports the Effect barrel`, switch `effectBarrel`); in godotjs-esm `starter/tests/effect-import-style` also fails on one and when the dev bundle passes its size limit; `docs/design/effect-bundle-size.md` in `godotjs-esm` has the numbers.

Upgrade procedure (`package.json` pins `effect` to `~4.0.1`, a patch range; `bun.lock` is the real pin):
1. Change the version in a scratch copy of the project, `bun add effect@<version>`, run `starter/tests/effect-core` and `starter/tests/effect-godot` on your binary and compare `tsc` output with the old version.
2. Only if both are green, bump `package.json` and `bun.lock` (in godotjs-esm also run `bun tools/verify.ts --update-baseline`: the bundle changes; say so in the commit).
3. A failure is a real break: stay on the old version. The exact commands and the versions tried: `docs/design/effect-upgrade-canary.md` in `godotjs-esm`.

## Testing your game

Three layers, cheapest first. Put each rule in the cheapest layer that can see it.

| Layer | Runs with | Sees Godot? | Speed | For |
|---|---|---|---|---|
| 1. Logic | `bun run test` (`bun test tests/logic`) | no | milliseconds | rules, maths, state machines, Effect programs, Schema decoding: anything in `src/lib/` |
| 2. Engine | `bun run test:engine` | yes, a headless Godot | a few seconds | nodes, scenes, signals, frames, script classes in `src/scripts/`, `connect(fn)`, `@onready` |
| 3. Play | `bun run start` / `bun run dev` | yes, with a window | you | feel, look, "is it fun" |

**Which one?** Does the code import `"godot"`? If not (ADR 0006: keep game rules in plain TypeScript, Godot only hosts them), it is a layer 1 test. Most of a game should be there: it is the fastest feedback and the only layer where a failure points at one function. Layer 2 is for the glue: that the node exists after `add_child`, that the signal arrives, that the script class built the way the scene expects. Do not test a rule through a scene when you can test it as a function.

### Logic tests (`tests/logic/*.test.ts`)

Plain `bun:test`. `tests/logic/rest.test.ts` tests a pure function from `src/lib/rest.ts`:

```ts
// snippet: skip - imports are relative to a test project folder (tests/<name>/), not to the doc
import { describe, expect, it } from "bun:test";
import { recoverStamina } from "../../src/lib/rest";
describe("recoverStamina", () => {
  it("adds 5 per hour", () => expect(recoverStamina(50, 2)).toBe(60));
});
```

**An Effect service, with a Layer** (Effect projects; `tests/logic/camp.test.ts` runs against `src/lib/camp.ts`). A service is a `Context.Service` class (the port); the game provides a live Layer, the test provides a fake one. Time is a service too: `TestClock` makes `Effect.sleep("1 hour")` finish when the test says so, with no real time passing.

```ts
// snippet: skip - continues the camp.ts example above (Medic, nightAtCamp), not self-contained
const KindMedic = Layer.succeed(Medic, { bonus: (hour) => (hour === 2 ? 10 : 0) });   // the fake
const program = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(nightAtCamp({ name: "Gal", stamina: 50 }, 3)); // 3 game hours
  yield* Effect.yieldNow;                                                              // let it reach its first sleep
  yield* TestClock.adjust("3 hours");                                                  // the only thing that moves time
  return yield* Fiber.join(fiber);
});
const soldier = await Effect.runPromise(program.pipe(Effect.provide(KindMedic), Effect.provide(TestClock.layer())));
expect(soldier.stamina).toBe(75);
```

Schema is tested the same way: `Schema.decodeUnknownSync(Soldier)(badSave)` must throw (`expect(() => ...).toThrow()`).

### Engine tests (`tests/engine/*.test.ts`)

`bun run test:engine` bundles every `tests/engine/**/*.test.ts` with the game (same build plugin, so `connect(fn)`, decorators and `@onready` behave as in `src/`), launches the configured binary headless on a generated scene, and judges the TAP output. The tests import the kit, `tools/test-kit.ts`:

```ts
// snippet: skip - imports are relative to a test project folder (tests/<name>/), and makeSpinner is the reader's own
import { describe, expect, it } from "../../tools/test-kit";

describe("Spinner", () => {
  it("delivers a signal, a frame later too", async ({ add, nextFrame }) => {
    const spinner = add(makeSpinner());          // added under the test root; freed after the test
    const seen: number[] = [];
    spinner.spun.connect((n) => seen.push(n));
    spinner.spun.emit(7);
    await nextFrame();                           // waits for the next process frame
    expect(seen).toEqual([7]);
  });
});
```

API: `describe(name, body)`, `it(name, fn, timeoutMs?)` (default timeout 5000 ms; `fn` may be async), `it.skip`, `it.effect(name, ctx => effect)` (runs an Effect; add `import "../effect-support";` once per file; the Effect's failure fails the test), `expect(x)` with `toBe`, `toEqual`, `toBeCloseTo`, `toBeTruthy`, `toBeFalsy`, `toBeNull`, `toBeUndefined`, `toContain`, `toHaveLength`, `toBeGreaterThan(OrEqual)`, `toBeLessThan(OrEqual)`, `toThrow`, all with `.not`, plus `await expect(promise).rejects.toThrow()`. The test function gets `{ root, add, nextFrame }`. After every test, pass or fail, the kit frees what `add` added and puts `get_tree().paused` back to false and `Engine.time_scale` back to 1 (it prints `# reset after ...` when a test left them changed), so one test cannot freeze the next. `bun run test:engine -- --filter spinner` runs only matching files; `--keep` leaves the generated `tests/_runner/` for debugging.

`tests/engine/engine.test.ts` also shows the "dev helpers are harmless" check (`hotReload()`, `devState()` and `hot()` outside `bun run dev`).

The runner is test-only: `src/` never imports `tools/test-kit.ts`, the generated entry and its bundle are deleted when the run ends, and `tests/` is excluded from exports, so nothing of it ships. It needs no Bun inside the engine. (In a `godotjs-esm` checkout these samples live in `starter/game-tests/` and `create-godotjs-bun` copies them to your `tests/`.)

Gotcha: a promise that is ALREADY rejected when created (`Promise.reject(...)`, an async function that throws at once) makes the engine log "unhandled promise rejection", and the run fails on that line even if a handler follows. In a test, reject later (inside a timer) or use `rejects.toThrow` on a promise that rejects after an await.

### Soak your game

A leak hides from a 10-second test and from the leak report at exit; a slope over many minutes shows it. `src/lib/soak-probe.ts` (opt-in, no Effect needed) samples engine objects, nodes, orphans, static memory and RSS, plus any counter you pass, and asserts the least-squares slope after warm-up:

```ts
import { engineMetrics, SoakProbe } from "./lib/soak-probe";
let myFiberCount = 0; // any counter of your own (optional)
const probe = new SoakProbe({ ...engineMetrics(), fibers: () => myFiberCount });
// in _process, every 300 frames:  probe.sample(frame / 3600)     (x = game minutes)
for (const line of probe.judge({ objects: 30, nodes: 1, orphans: 1, rss_mb: 6 }).lines) console.log(line); // at the end
```

Run your real game loop headless with `--fixed-fps 60` (minutes of play in seconds), then once for 30 minutes paced (`--max-fps 60`). Prove each budget once with a deliberate leak that must trip it (the negative-control habit). Never read `GodotJS/*` monitors in a loop (ticket 303). Example with budgets and controls: `starter/tests/soak` in `godotjs-esm`.

### Record and replay input

A play session becomes a regression test: `src/lib/input-replay.ts` (opt-in, no Effect) writes every input event the window receives to `user://` and feeds a recording back at the same frames.

```ts
import { inputReplay } from "./lib/input-replay";
export class Main extends Node { _ready(): void { inputReplay(this); } } // acts only on -- --record[=path] / -- --replay=path
```

Play once with `-- --record` (to `user://input.replay`), then replay headless with `--fixed-fps 60 -- --replay=user://input.replay` (fixed frame deltas make the replay exact) and compare what your game prints per frame. The recorder adds no engine object per event (a JS `_input` handler would keep one: ticket 231). Design and measurements: `docs/design/input-replay.md` in `godotjs-esm`.

### How a failing test looks

Logic (bun):

```
error: expect(received).toBe(expected)
Expected: 60
Received: 55
(fail) recoverStamina > adds 5 per hour
```

Engine (TAP, one line per test, the reason and the file on the next lines, a non-zero exit code; the summary names only the files with a failing test):

```
not ok 12 - Spinner > delivers a signal, a frame later too
  # expected [7] toEqual [7,8]
  # in engine/spinner.test.ts
# 11 passed, 1 failed
FAIL engine tests: 1 of 12 failed (engine/spinner.test.ts)
```

The command fails when any test fails, when a test hangs (its timeout), when the engine dies half-way (the TAP plan says how many tests there should be), or when the engine logs an `ERROR:` line.

### The negative-control habit

A test that cannot fail proves nothing. After you write a test, break the thing it guards (change `5` to `4` in `recoverStamina`, remove the `connect`), run the suite, and watch THIS test go red; then put the code back. If it stays green, the test is not testing what you think. Do it once per new test; it takes a minute and it is the difference between a safety net and a decoration.

## Layout

| Path | What |
|---|---|
| `src/**/*.ts` | every file becomes a Godot script bundle at `.godot/GodotJS/<same path>.js`, except `src/lib/` |
| `src/lib/` | plain shared TypeScript; Bun inlines it into the scripts that import it, Godot never loads it as a script. `gd.ts` is the runtime half of the build plugin |
| `tools/` | build, dev runner, config, launcher, and `tools/plugin` (hidden from Godot with `.gdignore`; so are `typings/`, `src/lib/`, `docs/`) |
| `tests/logic/`, `tests/engine/` | your tests: logic tests run with `bun test`, engine tests run in a headless Godot (`bun run test:engine`; runner in `tools/test-kit.ts` and `tools/test.ts`). See Testing your game |
| `export_presets.cfg`, `out/` | the macOS export preset (exclude filter hides tooling, never `*.ts`); `out/` is where the exported app lands (gitignored). Shipping, signing and notarizing: `docs/SHIPPING.md` |
| `typings/` | Godot API typings (a small stub until you run `bun run types`) |

Scenes attach the `.ts` path (`res://src/main.ts`), never the bundle.

## Updating the toolchain

The build tooling lives in your project as plain files (`tools/**`, `src/lib/gd.ts`, `src/lib/dev-state.ts`, `src/lib/hot-reload.ts`, `src/lib/hot.ts`, `polyfills/`, `.githooks/`, `.vscode/`; the list is `tools/toolchain-files.json`). Your game code, `project.godot`, scenes and `package.json` are never touched. To pick up fixes, point the updater at a newer template: the `starter/` of a `godotjs-esm` checkout, or an unpacked `create-godotjs-bun` `template/` (`bunx github:Galz648/create-godotjs-bun#vX.Y.Z tmp-dir --no-install` and use `tmp-dir`).

```sh
bun tools/update.ts /path/to/template --dry-run   # what would change
bun tools/update.ts /path/to/template             # do it
```

`tools/toolchain.json` records the hash of every toolchain file as installed. A file you have not edited is overwritten; one you edited is left alone with its diff printed and exit code 3 (`--force` takes the template's version anyway). A project made before that file existed has no record: run once with `--adopt` to take its current files as the baseline (commit first, `git diff` is your safety net). A project with no `tools/update.ts` yet runs the template's copy: `bun /path/to/template/tools/update.ts /path/to/template --project .`.

## Gotchas

- On the stock engine the build plugin (`bun run build`) is what makes these work: `@gd.export()` reads the type and the literal (`100` int, `1.5` / `200.0` float; `@gd.export.int()` / `.float()` when the initializer is not a literal), typed array and Resource exports, `@gd.onready("Label")` after a missing path (later fields still run), and `signal.connect(fn)` with a plain function or arrow (`this` inside a bare function is undefined; use `() => this.method()`). `await signal.as_promise()` also works.
- `set_script` on a JS class still does not run the constructor on the stock engine (`Cannot read from private field`). The plugin warns at build time and does not rewrite the call. Use `ResourceLoader.load(path).call("new")`. A patched engine (dev-only) runs the constructor inside `set_script`.
- Scalar Node export `class_name` stays empty on the stock engine. Clickable TypeScript errors and mapped positions in the editor Output panel need the patched editor. The stock binary prints bundle positions; `bun run headless:mapped` maps them in the terminal.
- Exports and signals use TC39 decorators and `accessor` fields (`@gd.export()` / `@gd.onready()` in `src/lib/gd.ts`). You do not write `@gd.class`: the plugin adds it to a default-exported class that extends a Godot class and has a member `@gd` decorator or a Signal-typed accessor (an explicit `@gd.class` still works). A signal is just `accessor spun!: Signal<(amount: number) => void>` (`@gd.signal()` in front is optional). The same decorators on a class that is not the default export or does not extend a Godot class, and `@gd.export` / `@gd.signal` on a plain field, fail the build with the file and line.
- Editor reload keeps live accessor values: `@gd.export()` accessors and plain `accessor` fields of a script class are stored on the instance (a hidden `Symbol.for("godotjs.accessor:<Class>.<field>")` property), so an inspector and JS reads keep working after you edit and refocus the editor. The plugin adds `@gd.stored("<Class>.<field>")` to plain accessors itself; this works with several decorated classes in one file or across files (the dev build renames identifiers, see below). `@bind.export` accessors written by hand are not covered. A constructor does not re-run on reload, a new instance gets the new default.
- Dev builds rename identifiers (`minify: { identifiers: true }` in `tools/build.ts`), because Bun otherwise gives every decorated class in a bundle the same hidden `_init` helper and the last one wins (`docs/design/cross-file-decorators.md` in `godotjs-esm`). Cost: class names are mangled in dev stack frames and in `constructor.name` (`new J`); method names and mapped positions (`bun run headless:mapped`) are intact. To see real class names while debugging a project with a single decorated class, build with `GODOTJS_NO_MINIFY_IDS=1 bun run build`; with several decorated classes that build breaks them again, so use it only for a quick look.
- Every plugin rewrite (typed exports, `@onready`, class registration, stored accessors, `connect(fn)` wrapping; the abort guards too) has an off switch and an explicit form you can write by hand: `"godotjs": { "plugin": { "connect": false } }` in `package.json`, or `GODOTJS_PLUGIN_OFF=exports,connect` for one run. With a switch off, a construct that needs its rewrite fails the build and prints the explicit text. The table, every switch and the explicit forms: `docs/PLUGIN-REWRITES.md` (the switches are also listed in `tools/plugin/options.ts`).
- Build warnings start with `[tooling]` and carry the original `file:line:col`. They never change the output; they flag code that runs but does the wrong thing on the stock engine: `this` in a plain function or method passed to `connect` (use `() => this.method()`), an `@onready` field read in a field initializer or constructor (it is assigned at the start of `_ready`), `node.position.x = 5` and the other writes into a copy (the engine hands back a copy; assign `node.position = ...`; list in the next bullet), and `await signal` (use `await signal.as_promise()`). Three more name a leak or a bloat with its safe form: the Effect barrel import (`effectBarrel`), the leak-family calls (`leakCalls`) and `_input` / `_unhandled_input` methods (`inputVirtuals`); see the leak table above. Each is a switch in `package.json` `godotjs.plugin` (`false` turns it off for the project), and `// godotjs-plugin-allow: <switch names>` turns them off for one file. Two more look at your scenes: `@gd.onready("Path")` where no scene that attaches the script has that path (the warning names the scene), and where the node is a different class than the field type (`Label` field, `Control` node). They stay silent for scripts no scene attaches, `%Unique` and `..` paths, and paths inside an instanced sub-scene; a node you add in code before `_ready` is not in the scene, so ignore the warning there. A class with `@gd.onready` and no `_ready` of its own still runs its base class's `_ready` (the generated one calls `super._ready?.()`). `connect()` with a class or a non-callable is a build error.
- Four more checks catch bugs that run and answer wrong (details and safe forms: `docs/PLUGIN-REWRITES.md`, section "Value-type diagnostics"). A write into a member of a value type the engine hands out is lost: `this.velocity.y -= g`, `node.rotation.y = x`, `node.scale.x *= 2`, `node.transform.origin.x = 4`, `aabb.position.x = 1`, `t.basis.x.y = 1` (warning; read into a local, change it, assign it back, or assign a `new Vector3(...)`). A builtin value type in a template literal, `String(v)`, `"" + v` or `JSON.stringify(v)` gives `[object Object]` / `{}` (warning; use `str(v)` from `"godot"`, or the fields). `for...of`, spread or `Array.from` of a `Packed*Array` throws "not iterable" or gives `[]` (warning; `Array.from({ length: p.size() }, (_, i) => p.get(i))`). `new Quaternion(basis)`, `new Projection(transform)` and `new Transform3D(projection)` return garbage with no error, so they are build errors (`basis.get_rotation_quaternion()`; the other two: the message spells out the column constructors). They need the type to be known (generated typings make most engine members known) and stay silent otherwise. Off: `"lostWrites"`, `"valueStrings"`, `"packedIteration"`, `"badConversions"` set to `false` in `package.json` `godotjs.plugin`.
- Some calls abort or hang the whole engine (no script error to catch), so the build refuses them with `ENGINE ABORT (engine ticket NN)` and the safe form: `new Vector2(v)` with a `Vector2i` (and `Vector3/4`, `Rect2`; write `new Vector2(v.x, v.y)`), `new Basis(quaternion)`, `new GArray(packedArray)` (copy with `push_back`), `x.unreference()` on a RefCounted, `input_count = -1` on an `AnimationNodeTransition`, `new GridMapEditorPlugin()` / `new ScriptCreateDialog()`, `Geometry2D.offset_polyline(new PackedVector2Array(), ...)`. It only sees types it can tell (an imported class, a `const`, an annotation); a value that comes back from an engine call is not checked. Off: `"abortGuards": false` in `package.json` `godotjs.plugin`. List and tickets: `docs/PLUGIN-REWRITES.md`.
- Shared code goes in `src/lib/`. Every other `.ts` under `src/` is built as a script entry, so a helper there that your script imports is bundled FIRST into that script, ahead of the `web-globals.js` polyfill import; if it imports `effect` the game then fails to load with `TextEncoder is not defined` (a clean build, an engine-time error). The build prints `warning: src/x.ts is shared code but sits outside src/lib/` for a module with no default export that another script imports (ticket 203).
- Any engine class works as a script base (`Area2D`, `CanvasLayer`, `RigidBody2D`, ...) with `@gd.export()` / `@gd.onready()` / Signal accessors. An exported Resource or Node type that the build plugin does not know (`PackedScene`, `Texture2D`) needs the generated typings: run `bun run types` once, otherwise the build says so (ticket 200).
- GDScript globals have JS forms (measured on the stock binary; the full table is `docs/GDSCRIPT-TO-GODOTJS.md` in `godotjs-esm`): `$Child` is `this.get_node("Child")` (no `$`); `load` / `preload` are `ResourceLoader.load("res://...")` (`as PackedScene`, then `instantiate()`); `print`, `printerr`, `floor`, `clamp`, `lerp`, `randf`, `str`, `is_instance_valid` and the other utility functions are imports from `"godot"`, not globals; `typeof(x)` is `require("godot")["typeof"](x)`; `node.name` is `node.get_name()`; `Vector2(1,2) + Vector2(3,4)` is `Vector2.ADD(a, b)` (also `SUBTRACT`, `MULTIPLY`, `NEGATE`); `Node.PROCESS_MODE_INHERIT` is `Node.ProcessMode.PROCESS_MODE_INHERIT` and `KEY_A` is `Key.KEY_A`; `"a".to_upper()` is plain JS (`"a".toUpperCase()`); a `StringName` is a plain string; `Dictionary` / `Array` are `GDictionary` / `GArray`; `node is Node2D` is `node instanceof Node2D`.
- `SceneTree.paused` and `Engine.time_scale` do not affect JS timers or `Effect.sleep` (see "Time" above for the opt-in game clock).
- The editor's Output panel prints ANSI color codes raw; only color output when running in a terminal.
- Opening the project in the editor creates `.uid` files and a `gen/` folder (scene typings, compiled by the build); both are gitignored.

## If something is off

| Symptom | Try |
|---|---|
| `no GodotJS binary configured` | `bun tools/config.ts set <path>` (global), or `GODOTJS=<path>` in the shell or in the project's `.env` |
| `@gd.export() was not rewritten` at startup | a watch build started BEFORE the plugin or `tools/` changed is still running with the old build code; stop it and run `bun run dev:build` again (or `bun run build` once) |
| Patched engine aborts at exit after `bun run types` (`FATAL ... internal_data_.is_empty()`) | the project's `polyfills/` folder needs its own `package.json` with `{ "type": "commonjs" }` (the starter has it); without it the patched native-ESM loader loads the polyfill as ESM and leaks at shutdown. Only patched builds; typings are written before the abort |
| Editor shows old code | is `bun run dev:build` running? |
| Errors point at `main.js:21746` | you are on the stock binary; use the patched one for mapped positions |
| `javascript file is missing` for a game script | the file must be under `src/` (not `src/lib/`) and built; run `bun run build` |

## Effect across several scripts

Each script bundle that imports `effect` carries its own copy (about 50 ms of startup and 3 MiB each, 524 KB in a dev bundle, 332 KB minified; measured, see `docs/design/effect-multi-script.md` in `godotjs-esm`). The copies still interoperate: services, `Ref`s, `Queue`s, `Cause`s and fibers are looked up by string key and `Symbol.for`, so a service provided in one script is found from another. Give every service a unique string key (`Context.Service<...>()("game.Clock")`), and do not compare service classes with `===` or rely on `instanceof` across bundles (untested). A shared Effect runtime was prototyped and not adopted; revisit at about 15 Effect-using script bundles.

## Crossing the Godot boundary (measured, `starter/tests/effect-boundary`)

What happens to a JS value passed into Godot (a Dictionary, an Array, `set_meta`, a signal argument, a `Callable` argument or return). All five carriers behave the same:

- **Throws `InternalError`:** plain objects and arrays, `Uint8Array`, `Float64Array`, `Map`, `Set`, `Date`, class instances, functions, `Symbol`, and Effect `Option` / `Data.TaggedError`. Convert first. The safe lane is `Schema.toCodecJson` (Date, BigInt, Option, Map, Set, `Uint8Array`, tagged unions and nesting all round-trip exactly); pass its JSON-shaped result.
- **Silently changes:** `undefined` becomes `null`; a number becomes an int or a float depending on how QuickJS holds it, not on its value (`5` is an int, `1.5 + 1.5` is the float `3.0`, `JSON.parse("5")` and 2147483648 are floats, and int key 1 and float key 1.0 are different Dictionary keys); `StringName` comes back as a plain string; Vector3 and Color keep float32 precision; `ArrayBuffer` becomes `PackedByteArray`.
- **Silently loses data:** a BigInt of 2^63 or more wraps modulo 2^64 (2^64 becomes 0); a string containing NUL is cut at the NUL; a lone surrogate becomes U+FFFD.
- **Survives:** strings (emoji, CJK), NaN, ±Infinity, -0, all doubles and safe integers, null, booleans, Vector2/3, Rect2, Color, NodePath, nested Dictionary/Array (shared by reference), BigInt in [2^53, 2^63), Resource and Node identity while alive.

Errors: `Effect.try` catches JS exceptions (calls on a freed object, `call("nope")`, bad argument types). Many Godot errors do NOT throw: `get_node` of a missing path, `add_child(null)`, `connect` to a missing signal print an engine ERROR line and return normally, so `Effect.try` sees a success; `Dictionary.get` of a missing key and `queue_free` twice are silent. Check the result (`get_node_or_null`, return codes) instead of relying on a failure.

Callbacks: an Effect failure, defect or interrupt thrown inside a signal handler, `_process`, `_physics_process`, `call_deferred`, a Tween callback or a Timer timeout never stops the game loop, and the handler stays registered; the engine prints `exception thrown in function:` (`runPromise` prints an unhandled rejection with no stack, `runFork` prints nothing: use `runLogged` / `forkLogged` from `src/lib/godot-effect.ts`).

Lifetime (three engine defects, tickets 07 to 09 on the tooling map, pinned by tests so a fix is noticed):
- **Never leave a freed Object inside a Dictionary, Array or meta.** Reading the slot crashes the engine with signal 11. Clear the slot before `free()`.
- **A wrapper of a freed Object can be re-adopted by the next Godot object allocated at the same address**: `is_instance_valid(old)` turns true again and writes through `old` rename the impostor. Check `is_instance_valid` immediately before use, and do not keep wrappers of freed objects.
- **`get_instance_id()` of a `RefCounted` or `Resource` is a lossy negative Number**, so `instance_from_id` and `is_instance_id_valid` never work for it. Use `weakref(obj).get_ref()`.
- A dropped `RefCounted` / `Resource` is freed a frame later, not at once. An Effect `Ref` does not hold an engine reference. 2000 fiber-driven create/free cycles stayed flat in memory.

Order inside one frame (asserted): the `_process` body, the signal handler and the inline part of `runFork` run first; after the body, `promise.then`, `queueMicrotask`, `setImmediate`, `Effect.yieldNow`, `Effect.sleep(0)` and `runPromise.then` run in that order. Timers (`setTimeout(0)`, `Effect.sleep(5)`) fire 0 to 2 frames later. The job queue drains once per frame, after `_process`. In `_ready`, code before the first `await` runs at frame 0 and `await Promise.resolve()` continues in frame 0.

