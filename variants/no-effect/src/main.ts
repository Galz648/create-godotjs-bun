import "../polyfills/web-globals.js"; // TextEncoder, AbortController, fast setImmediate, Error.stack header (must be first)
import { Node, ResourceLoader, type Script } from "godot";
import { devState } from "./lib/dev-state";
import { gd } from "./lib/gd";
import { sharedTag } from "./lib/shared";

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
    this.add_child(load("res://src/scripts/Spinner.ts").call("new") as Node);
    devState("demo", { save: () => ({ ticks: this.ticks }), load: (s) => { this.ticks = s.ticks; } });
    setInterval(() => console.log(`demo ticks=${++this.ticks}`), 1000);
  }
}
