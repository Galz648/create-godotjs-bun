// Build warnings for the leak family and the Effect barrel import (leak-checks.ts, ticket 441). A positive case names the exact
// original file:line:col of each report; the controls must stay SILENT: a subpath or type-only import, a user method of the same
// name, a class that does not extend a Godot class, the GDScript text inside a string, the safe forms, a switch off, a file opt-out.
import { at, check, compile } from "./harness.ts";
import type { PluginRewrites } from "../options.ts";

const F = "/virtual/leaks.ts";

function reports(src: string, sw: string, rewrites: Partial<PluginRewrites> = {}): string[] {
  const result = compile({ [F]: src }, F, { rewrites }).map;
  return (result?.warnings ?? []).filter((w) => w.endsWith(`(switch ${sw})`)).map((w) => w.split(" ")[0]).sort();
}

/** Each needle (`needle@n` for the n-th occurrence) is reported once under switch `sw`, and nothing else is. */
function warnsAt(label: string, src: string, sw: string, needles: string[]): void {
  const want = needles.map((n) => { const [needle, nth] = n.split("@"); return at(F, src, needle, nth ? Number(nth) : 0); }).sort();
  const got = reports(src, sw);
  const show = (xs: string[]) => xs.map((x) => x.split(":").slice(1).join(":")).join(" ") || "none";
  check(JSON.stringify(got) === JSON.stringify(want), label, `want=${show(want)} got=${show(got)}`);
}

function silent(label: string, src: string, sw: string, rewrites: Partial<PluginRewrites> = {}): void {
  const got = reports(src, sw, rewrites);
  check(got.length === 0, label, got.length ? `reported at ${got.map((x) => x.split(":").slice(1).join(":")).join(" ")}` : "");
}

// --- effectBarrel ---
const barrel = `import { Effect } from "effect";\nimport * as E2 from "effect";\nimport "effect";\nexport { Layer } from "effect";\nexport const x = [Effect, E2];\n`;
warnsAt("leak-barrel-value-imports-and-reexport-warn", barrel, "effectBarrel", [`import { Effect }`, `import * as E2`, `import "effect"`, `export { Layer }`]);
silent(
  "leak-barrel-control-subpath-and-type-only-silent",
  `import * as Effect from "effect/Effect";\nimport type { Layer } from "effect";\nimport { type Stream } from "effect";\nexport type { Schema } from "effect";\nimport * as Fx from "effects";\nexport const y = Effect;\n`,
  "effectBarrel",
);
silent("leak-barrel-control-switch-off", barrel, "effectBarrel", { effectBarrel: false });

// --- leakCalls ---
const calls = `import { Node } from "godot";
declare const body: any;
export default class A extends Node {
  _ready(): void {
    (this as any).get_tree().create_timer(1.0);
    (this as any).create_tween().tween_property(this, "modulate:a", 0, 0.3);
    body.get_slide_collision(0);
    body.get_last_slide_collision();
  }
}
`;
warnsAt("leak-calls-warn-at-each-call", calls, "leakCalls", ["(this as any).get_tree().create_timer", "(this as any).create_tween()", "body.get_slide_collision", "body.get_last_slide_collision"]);
silent(
  "leak-calls-control-user-method-string-and-safe-forms-silent",
  `import { Node } from "godot";
class Anim { create_tween(): number { return 1; } create_timer(_s: number): number { return 2; } }
declare function tweenProperty(n: unknown, p: string, to: unknown, s: number): void;
declare function slideCollisions(b: unknown): unknown[];
const RELAY = \`func f(node):\\n\\tnode.create_tween()\\n\\tnode.get_tree().create_timer(1.0)\`;
export default class B extends Node {
  _ready(): void {
    new Anim().create_tween();
    new Anim().create_timer(1);
    tweenProperty(this, "modulate:a", 0, 0.3);
    slideCollisions(this);
    setTimeout(() => {}, 100);
    console.log(RELAY, "create_tween()");
  }
}
`,
  "leakCalls",
);
silent("leak-calls-control-switch-off", calls, "leakCalls", { leakCalls: false });
silent("leak-calls-control-file-opt-out", `${calls}// godotjs-plugin-allow: leakCalls (a test that leaks on purpose)\n`, "leakCalls");

// --- inputVirtuals ---
const virtuals = `import { Node, Node2D } from "godot";
export default class P extends Node2D {
  _input(ev: unknown): void {}
  _unhandled_input(ev: unknown): void {}
}
class Base extends Node {}
export class Q extends Base {
  _input(ev: unknown): void {}
}
`;
warnsAt("leak-input-virtuals-warn-on-godot-classes", virtuals, "inputVirtuals", ["_input(ev", "_unhandled_input(ev", "_input(ev@2"]);
silent(
  "leak-input-control-plain-class-other-methods-and-onInputEvent-silent",
  `import { Node } from "godot";
declare function onInputEvent(n: Node, h: (e: unknown) => void, o?: { unhandled?: boolean }): Node;
class Router { _input(ev: unknown): void {} _unhandled_input(ev: unknown): void {} }
export default class R extends Node {
  router = new Router();
  _ready(): void { onInputEvent(this, (ev) => this.router._input(ev)); }
  _process(): void {}
  _gui_input_like(): void {}
  static _input(): void {}
}
`,
  "inputVirtuals",
);
silent("leak-input-control-switch-off", virtuals, "inputVirtuals", { inputVirtuals: false });
silent("leak-input-control-file-opt-out", `${virtuals}// godotjs-plugin-allow: leakCalls, inputVirtuals\n`, "inputVirtuals");
