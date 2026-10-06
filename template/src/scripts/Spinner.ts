import { Node, type Signal } from "godot";
import { gd } from "../lib/gd";
import { sharedTag } from "../lib/shared";

@gd.class
export default class Spinner extends Node {
  // 1.5 has a decimal point, so the build plugin stores a float (type 3).
  @gd.export()
  accessor speed: number = 1.5;

  @gd.signal()
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
