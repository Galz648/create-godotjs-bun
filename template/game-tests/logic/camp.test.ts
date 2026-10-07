// LOGIC test of an Effect program: a fake service through a Layer, a virtual clock (TestClock), Schema decoding.
// No Godot involved, so `bun test` runs it in milliseconds. See docs/DAILY.md, "Testing your game".
import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { Medic, nightAtCamp, Soldier } from "../../src/lib/camp";

// The test Layer replaces the real Medic: this one adds nothing, so only the pure rule is left.
const NoMedic = Layer.succeed(Medic, { bonus: () => 0 });
const KindMedic = Layer.succeed(Medic, { bonus: (hour) => (hour === 2 ? 10 : 0) });

describe("nightAtCamp", () => {
  it("sleeps one game hour per hour, driven by the TestClock (no real time passes)", async () => {
    let finished = false;
    const program = Effect.gen(function* () {
      const night = nightAtCamp({ name: "Gal", stamina: 50 }, 3).pipe(Effect.tap(() => Effect.sync(() => { finished = true; })));
      const fiber = yield* Effect.forkChild(night);
      yield* Effect.yieldNow; // let the fiber reach its first sleep
      yield* TestClock.adjust("2 hours");
      const early = !finished; // two of three hours passed: not finished
      yield* TestClock.adjust("1 hour");
      return { early, soldier: yield* Fiber.join(fiber) };
    });
    const started = Date.now();
    const r = await Effect.runPromise(program.pipe(Effect.provide(NoMedic), Effect.provide(TestClock.layer())));
    expect(r.early).toBe(true);
    expect(r.soldier).toEqual({ name: "Gal", stamina: 65 });
    expect(Date.now() - started).toBeLessThan(1000); // three virtual hours, well under a real second
  });

  it("asks the Medic service each hour (a different Layer, a different night)", async () => {
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(nightAtCamp({ name: "Gal", stamina: 50 }, 3));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("3 hours");
      return yield* Fiber.join(fiber);
    });
    const soldier = await Effect.runPromise(program.pipe(Effect.provide(KindMedic), Effect.provide(TestClock.layer())));
    expect(soldier.stamina).toBe(75); // 3 hours x 5, plus the medic's 10 in hour 2
  });
});

describe("Soldier schema", () => {
  const decode = Schema.decodeUnknownSync(Soldier);
  it("accepts a good save", () => {
    expect(decode({ name: "Gal", stamina: 50 })).toEqual({ name: "Gal", stamina: 50 });
  });
  it("rejects a bad save", () => {
    expect(() => decode({ name: "Gal", stamina: "lots" })).toThrow();
  });
});
