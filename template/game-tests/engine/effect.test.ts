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
      yield* Effect.sleep("30 millis");
      expect(performance.now() - start).toBeGreaterThanOrEqual(25);
    }),
  );
});
