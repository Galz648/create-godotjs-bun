import "../polyfills/web-globals.js"; // TextEncoder, AbortController, fast setImmediate, Error.stack header (must be first)
import { Node, ResourceLoader, Variant, type Script } from "godot";
import { createClassBinder } from "godot.annotations";
import { Context, Effect, Layer, Schedule, Schema } from "effect";
import { sharedTag } from "./lib/shared";

// --- a port (service) and a live implementation, a ports-and-adapters pattern ---
class Clock2 extends Context.Service<Clock2, { hourLabel: (h: number) => string }>()("Clock2") {}
const ClockLive = Layer.succeed(Clock2, { hourLabel: (h) => `${String(h).padStart(2, "0")}:00` });

// --- Schema: decode untrusted data (a save file, say) ---
const Soldier = Schema.Struct({ name: Schema.String, stamina: Schema.Number });

const program = Effect.gen(function* () {
  const clock = yield* Clock2;
  const soldier = Schema.decodeUnknownSync(Soldier)({ name: "Gal", stamina: 50 });
  console.log(`hello ${soldier.name}, stamina ${soldier.stamina}`);

  // an hourly game clock: 1 tick every 100 ms here (use 1000 for 1 s = 1 in-game hour)
  let hour = 0;
  yield* Effect.sync(() => { console.log(`tick ${clock.hourLabel(++hour)}`); }).pipe(
    Effect.repeat({ schedule: Schedule.spaced(100), times: 4 }),
  );
  return "done";
}).pipe(Effect.provide(ClockLive));

const bind = createClassBinder();

// GDScript's global `load` is not injected into bundled modules. Same call: ResourceLoader.load.
function load(path: string): Script {
  return ResourceLoader.load(path) as Script;
}

@bind() // registers the class with Godot so @export and signals work
export default class GameRoot extends Node {
  @bind.export(Variant.Type.TYPE_INT) // shows up in the inspector; the scene can override it
  accessor health: number = 100;

  _ready(): void {
    console.log(sharedTag("GameRoot"));
    console.log(`GameRoot ready, health=${this.health}`);
    // Instantiate through the script (`new` on the Script object). `new Node()` + `set_script()` leaves TC39 `accessor`
    // fields uninitialised ("Cannot read from private field").
    const spinner = load("res://src/scripts/Spinner.ts").call("new") as Node;
    this.add_child(spinner);
    Effect.runPromise(program)
      .then((r) => console.log(`program finished: ${r}`))
      .catch((e) => console.log(`program failed: ${e}`));
  }
}
