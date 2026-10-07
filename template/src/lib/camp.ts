// An Effect service with a Layer, plus a program that waits in game time. Sample for the testing kit
// (tests/logic/camp.test.ts): the test provides a fake Medic and a TestClock, so a night at camp costs no real time.
// Imports effect, so create-godotjs-bun leaves it out of the --no-effect template.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { recoverStamina } from "./rest";

/** Untrusted data (a save file) is decoded through this: `Schema.decodeUnknownSync(Soldier)(json)` throws on a bad shape. */
export const Soldier = Schema.Struct({ name: Schema.String, stamina: Schema.Number });
export type Soldier = typeof Soldier.Type;

/** The port: how much extra stamina the medic adds in a given hour of the night. */
export class Medic extends Context.Service<Medic, { bonus: (hour: number) => number }>()("Medic") {}
export const MedicLive = Layer.succeed(Medic, { bonus: (hour) => (hour === 1 ? 2 : 0) });

/** One game hour (an Effect.sleep) per hour of rest; stamina grows by the pure rule plus the medic's bonus. */
export const nightAtCamp = (soldier: Soldier, hours: number) =>
  Effect.gen(function* () {
    const medic = yield* Medic;
    let stamina = soldier.stamina;
    for (let hour = 1; hour <= hours; hour++) {
      yield* Effect.sleep("1 hour");
      stamina = recoverStamina(stamina + medic.bonus(hour), 1);
    }
    return { ...soldier, stamina };
  });
