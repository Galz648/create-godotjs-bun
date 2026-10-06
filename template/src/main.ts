import "../polyfills/web-globals.js"; // TextEncoder, AbortController, fast setImmediate, Error.stack header (must be first)
import { Node, ResourceLoader, type Script } from "godot";
import { Context, Effect, Layer, Schedule, Schema } from "effect";
import { devState } from "./lib/dev-state";
import { gd } from "./lib/gd";
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

// GDScript's global `load` is not injected into bundled modules. Same call: ResourceLoader.load.
function load(path: string): Script {
  return ResourceLoader.load(path) as Script;
}

// No @gd.class needed: a default-exported class with @gd member decorators is registered by the build plugin.
export default class GameRoot extends Node {
  // Survives `bun run dev` relaunches (see src/lib/dev-state.ts). Edit a file and watch the count continue.
  private ticks = 0;

  // 100 has no decimal point, so the build plugin stores an int. The scene overrides it to 42.
  @gd.export()
  accessor health: number = 100;

  @gd.export()
  accessor tags: string[] = ["demo"];

  @gd.onready("Label")
  label!: Node;

  _ready(): void {
    console.log(sharedTag("GameRoot"));
    console.log(`GameRoot ready, health=${this.health}`);
    console.log(`GameRoot label=${String(this.label.get_name())} tags=${this.tags.join(",")}`);
    // Instantiate through the script. `set_script` on a JS class does not run the constructor on the
    // stock engine (accessor fields stay uninitialised). The build plugin warns if you call it.
    // `call("new")` constructs once on the stock engine and on a patched engine.
    const spinner = load("res://src/scripts/Spinner.ts").call("new") as Node;
    this.add_child(spinner);
    devState("demo", { save: () => ({ ticks: this.ticks }), load: (s) => { this.ticks = s.ticks; } });
    setInterval(() => console.log(`demo ticks=${++this.ticks}`), 1000);
    Effect.runPromise(program)
      .then((r) => console.log(`program finished: ${r}`))
      .catch((e) => console.log(`program failed: ${e}`));
  }
}
