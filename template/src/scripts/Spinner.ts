import { Node, Variant, type Signal } from "godot";
import { createClassBinder } from "godot.annotations";
import { sharedTag } from "../lib/shared";

const bind = createClassBinder();

@bind()
export default class Spinner extends Node {
  @bind.export(Variant.Type.TYPE_FLOAT)
  accessor speed = 1.5;

  @bind.signal()
  accessor spun!: Signal<(amount: number) => void>;

  _ready(): void {
    console.log(sharedTag("Spinner"));
    console.log(`Spinner ready, speed=${this.speed}, spun=${this.has_signal("spun")}`);
  }
}
