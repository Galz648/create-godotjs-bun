// Opt-in Effect Clock driven by the engine's FRAME DELTA, not by wall time (`game-clock.ts` is the wall-time one).
// Same arithmetic as scene/main/timer.cpp: every sleeper holds `left` seconds, each frame does `left -= delta`, and it
// wakes when `left < 0` (strictly). Use it when time must match what Godot's own Timer nodes, tweens and `_process(delta)`
// see: tests and replays under `--fixed-fps` (the wall-time clock never advances there, ticket 202), differential
// tests against a GDScript twin, anything deterministic. Pause and `Engine.time_scale` come for free: the engine already
// stops or scales `delta`. Imports effect, so a project without Effect must not import this file.
//   const clock = makeFrameClock();   _process(delta) { clock.advance(delta); }
//   Effect.schedule(spawn, clock.timer(500)).pipe(Effect.provideService(Clock.Clock, clock))
//
// `timer(ms)` is the schedule a repeating Godot Timer is. A Timer that fires late (its frame overshot the wait) does
// `time_left += wait_time`: the overshoot is carried, so it never drifts. `Schedule.spaced` sleeps `ms` again from the wake-up
// frame, which loses the overshoot: at 60 fps a 0.5 s timer then fires every 31 frames instead of 30 (measured, docs/design/
// real-workloads.md). `timer` arms the carry for the NEXT sleep of the same fiber only, so a plain `Effect.sleep` still starts fresh
// (as `Timer.start()` and `create_timer` do in the original).
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export interface FrameClock extends Clock.Clock {
  /** Call once per frame with the engine's delta (seconds). Wakes the sleepers whose time ran out. */
  readonly advance: (deltaSeconds: number) => void;
  /** A repeating schedule that keeps the overshoot of a late frame, like a Godot Timer (no drift). */
  readonly timer: (waitMs: number) => Schedule.Schedule<number>;
  /**
   * A sleep that already counts the frame it starts in, and wakes at `left <= 0`: what `get_tree().create_timer(s)` does (the tree
   * steps its timers AFTER the nodes of the frame, so a timer made during the frame is stepped once at once). Same frame count as
   * the engine timer without creating a SceneTreeTimer: the JS wrapper of that object is never freed (ticket 201).
   */
  readonly sleepCounting: (waitMs: number) => Effect.Effect<void>;
  /** Game seconds elapsed. */
  readonly seconds: () => number;
  /** Sleepers waiting right now (a leak check). */
  readonly sleepers: () => number;
}

interface Sleeper {
  left: number;
  fiber: number;
  inclusive: boolean; // wake at left <= 0 (SceneTreeTimer) instead of left < 0 (Timer node)
  wake: () => void;
}

export function makeFrameClock(): FrameClock {
  let game = 0;
  let lastDelta = 0;
  const waiting = new Set<Sleeper>();
  const leftover = new Map<number, number>(); // fiber id -> `left` (<= 0) of its latest wake, valid for this frame only
  const armed = new Set<number>(); // fibers whose next sleep starts at `wait + leftover`
  const nanos = (s: number) => BigInt(Math.round(s * 1_000_000_000));
  const sleep = (duration: Duration.Duration) => {
    const ms = Duration.toMillis(duration);
    if (ms <= 0) return Effect.yieldNow;
    if (!Number.isFinite(ms)) return Effect.never;
    return Effect.withFiber<void>((fiber) =>
      Effect.callback<void>((resume) => {
        let left = ms / 1000;
        if (armed.delete(fiber.id)) left += leftover.get(fiber.id) ?? 0;
        const s: Sleeper = { left, fiber: fiber.id, inclusive: false, wake: () => resume(Effect.void) };
        waiting.add(s);
        return Effect.sync(() => void waiting.delete(s));
      }),
    );
  };
  return {
    advance: (delta) => {
      game += delta;
      lastDelta = delta;
      leftover.clear();
      armed.clear();
      for (const s of [...waiting]) {
        if (!waiting.has(s)) continue; // interrupted by an earlier wake in this same loop
        s.left -= delta;
        if (s.inclusive ? s.left <= 0 : s.left < 0) {
          waiting.delete(s);
          leftover.set(s.fiber, s.left);
          s.wake();
        }
      }
    },
    timer: (waitMs) =>
      Schedule.fromStep(
        Effect.sync(() => {
          let n = 0;
          return (_now: number, _input: unknown) =>
            Effect.withFiber((fiber) => {
              armed.add(fiber.id);
              return Effect.succeed([n++, Duration.millis(waitMs)] as [number, Duration.Duration]);
            });
        }),
      ),
    sleepCounting: (waitMs) =>
      Effect.callback<void>((resume) => {
        const s: Sleeper = { left: waitMs / 1000 - lastDelta, fiber: -1, inclusive: true, wake: () => resume(Effect.void) };
        waiting.add(s);
        return Effect.sync(() => void waiting.delete(s));
      }),
    seconds: () => game,
    sleepers: () => waiting.size,
    currentTimeMillisUnsafe: () => game * 1000,
    currentTimeMillis: Effect.sync(() => game * 1000),
    currentTimeNanosUnsafe: () => nanos(game),
    currentTimeNanos: Effect.sync(() => nanos(game)),
    monotonicTimeNanosUnsafe: () => nanos(game),
    monotonicTimeNanos: Effect.sync(() => nanos(game)),
    sleep,
  };
}
