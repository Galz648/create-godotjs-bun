import "../polyfills/web-globals.js"; // TextEncoder, AbortController, fast setImmediate, Error.stack header (must be first)
import { Node, ResourceLoader, Variant, type Script } from "godot";
import { createClassBinder } from "godot.annotations";
import { sharedTag } from "./lib/shared";

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
    this.add_child(load("res://src/scripts/Spinner.ts").call("new") as Node);
  }
}
