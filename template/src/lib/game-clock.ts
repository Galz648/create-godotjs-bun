// Opt-in Effect Clock that follows GAME time. Effect.sleep, timeout, Schedule.* and DateTime/Clock reads then
// stop while the tree is paused and stretch or shrink with Engine.time_scale. Plain setTimeout, setInterval and
// the stock Effect clock keep running on wall time (docs/design/effect-time.md has the measurements).
//   const clock = makeGameClock(this.get_tree());
//   Effect.runPromise(program.pipe(Effect.provideService(Clock.Clock, clock)));   // or Layer.succeed(Clock.Clock, clock)
//   clock.dispose();                                                           // when the owner leaves the tree
// Game time advances once per frame by (wall delta x time_scale), and not at all while tree.paused, so it is as
// accurate as a frame (a time_scale change mid-frame is applied to the whole frame). Imports effect, so a project
// without Effect must not import this file (create-godotjs-bun leaves it out of the --no-effect template).
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

// Typed locally and required lazily (like hot-reload.ts), so this file typechecks with the shim and the generated typings alike.
interface Tree {
  paused: boolean;
  process_frame: { connect(callable: unknown): void; disconnect(callable: unknown): void };
}
const godot = () => require("godot") as { Callable: { create(fn: () => void): unknown }; Engine: { time_scale: number } };

export interface GameClock extends Clock.Clock {
  /** Game milliseconds elapsed since this clock was made. */
  readonly gameMillis: () => number;
  /** Stop following the tree; sleepers still waiting never wake (interrupt them first). */
  readonly dispose: () => void;
}

export function makeGameClock(tree: Tree): GameClock {
  const { Callable, Engine } = godot();
  const origin = Date.now();
  let game = 0;
  let last = performance.now();
  const sleepers = new Set<{ at: number; wake: () => void }>();
  let live = true;
  const onFrame = () => {
    if (!live) return;
    const t = performance.now();
    if (!tree.paused) game += (t - last) * Engine.time_scale;
    last = t;
    for (const s of [...sleepers]) {
      if (s.at <= game) {
        sleepers.delete(s);
        s.wake();
      }
    }
  };
  const frameCallable = Callable.create(() => onFrame()); // explicit: works with or without the build plugin
  tree.process_frame.connect(frameCallable);
  const nanos = (ms: number) => BigInt(Math.round(ms * 1_000_000));
  return {
    gameMillis: () => game,
    dispose: () => {
      live = false;
      tree.process_frame.disconnect(frameCallable); // measured: without this every clock leaks ~460 bytes (tests/effect-time gameclock.tscn)
      sleepers.clear();
    },
    currentTimeMillisUnsafe: () => origin + game,
    currentTimeMillis: Effect.sync(() => origin + game),
    currentTimeNanosUnsafe: () => nanos(origin + game),
    currentTimeNanos: Effect.sync(() => nanos(origin + game)),
    monotonicTimeNanosUnsafe: () => nanos(game),
    monotonicTimeNanos: Effect.sync(() => nanos(game)),
    sleep: (duration) => {
      const ms = Duration.toMillis(duration);
      if (ms <= 0) return Effect.yieldNow;
      if (!Number.isFinite(ms)) return Effect.never;
      return Effect.callback<void>((resume) => {
        const s = { at: game + ms, wake: () => resume(Effect.void) };
        sleepers.add(s);
        return Effect.sync(() => void sleepers.delete(s));
      });
    },
  };
}
