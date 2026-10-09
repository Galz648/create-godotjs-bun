// ENGINE test of an Effect that touches the engine: the Effect adds a node and waits for a real frame.
// `it.effect` runs the Effect and fails the test with its error. See docs/DAILY.md, "Testing your game".
import { is_instance_valid, Node } from "godot";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "../../tools/test-kit";
import "../effect-support";

describe("Effect in the engine", () => {
  it.effect("an Effect that adds a node and waits for a frame", ({ add, nextFrame }) =>
    Effect.gen(function* () {
      const node = add(new Node());
      yield* Effect.promise(() => nextFrame());
      expect(is_instance_valid(node)).toBe(true);
    }),
  );

  it.effect("Effect.sleep runs on the real clock in the engine", () =>
    Effect.gen(function* () {
      const start = performance.now();
      yield* Effect.sleep("100 millis");
      // The engine's timer wheel can fire a timer EARLY (by up to about one 10 ms step, more for short timers armed in _process; see
      // docs/DAILY.md "Time"), so never assert an exact floor. 50 ms is far from "instant" (a TestClock or a broken sleep gives ~0).
      expect(performance.now() - start).toBeGreaterThanOrEqual(50);
    }),
  );
});
