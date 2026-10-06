import { Node, type Signal } from "godot";
import { gd } from "../lib/gd";
import { sharedTag } from "../lib/shared";

// No @gd.class and no @gd.signal(): the build plugin registers the class (it has an @gd.export) and
// treats a Signal-typed accessor as a signal declaration. The explicit decorators still work.
export default class Spinner extends Node {
  // 1.5 has a decimal point, so the build plugin stores a float (type 3).
  @gd.export()
  accessor speed: number = 1.5;

  accessor spun!: Signal<(amount: number) => void>;

  _ready(): void {
    console.log(sharedTag("Spinner"));
    console.log(`Spinner ready, speed=${this.speed}, spun=${this.has_signal("spun")}`);
    this.spun.connect((amount) => {
      console.log(`Spinner spun amount=${amount}`);
    });
    this.spun.emit(1);
  }
}
