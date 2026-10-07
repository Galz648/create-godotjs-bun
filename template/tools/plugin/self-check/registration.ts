// Automatic class registration, type-only signals.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { setEngineClassRoot } from "../engine-classes.ts";
import { lookupOriginal, offsetToPos } from "../sourcemap.ts";
import { check, compile, at, mustThrowAt, gdDecl } from "./harness.ts";

// -- 1. automatic @gd.class ---------------------------------------------------------------
const autoFile = `/virtual/auto.ts`;
const autoSrc = `import { Node } from "godot";
${gdDecl}export default class Auto extends Node {
  @gd.export()
  accessor health: number = 100;
}
`;
const autoOut = compile({ [autoFile]: autoSrc }, autoFile).text;
check(autoOut.includes("@gd.class export default class Auto"), "auto-class-added");
check((autoOut.match(/gd\.class/g) ?? []).length === 1, "auto-class-once");

const explicitFile = `/virtual/explicit.ts`;
const explicitSrc = `import { Node } from "godot";
${gdDecl}@gd.class
export default class Explicit extends Node {
  @gd.export()
  accessor health: number = 100;
  @gd.signal()
  accessor hit!: Signal<() => void>;
}
`;
const explicitOut = compile({ [explicitFile]: explicitSrc }, explicitFile).text;
check((explicitOut.match(/gd\.class/g) ?? []).length === 1, "explicit-class-no-double");
check((explicitOut.match(/gd\.signal\(\)/g) ?? []).length === 1, "explicit-signal-no-double");

const plainFile = `/virtual/plain.ts`;
const plainSrc = `import { Node } from "godot";
export default class Plain extends Node {
  accessor n: number = 1;
  m = 2;
}
`;
const plainOut = compile({ [plainFile]: plainSrc }, plainFile).text;
check(
  plainOut.includes('@__gd.stored("Plain.n") accessor n') && !plainOut.includes("gd.class") && !plainOut.includes("m = 2;\n  @"),
  "plain-accessor-gets-stored-only",
);
check(compile({ [plainFile]: plainSrc }, plainFile, { rewrites: { stored: false } }).map === null, "plain-class-untouched-when-stored-off");
const helperFile = `/virtual/helper.ts`;
const helperSrc = `import { Node } from "godot";
class Helper extends Node {
  accessor n: number = 1;
}
export default class Main extends Node {
  static accessor s = 1;
  #p = 1;
}
export { Helper };
`;
check(compile({ [helperFile]: helperSrc }, helperFile).map === null, "stored-skips-non-script-class-and-static");

const namedDefault = `/virtual/named-default.ts`;
const namedDefaultOut = compile(
  {
    [namedDefault]: `import { Node } from "godot";
${gdDecl}class Late extends Node {
  @gd.export()
  accessor health: number = 100;
}
export default Late;
`,
  },
  namedDefault,
).text;
check(namedDefaultOut.includes("@gd.class class Late"), "auto-class-export-default-name");

const inheritFile = `/virtual/inherit.ts`;
const inheritOut = compile(
  {
    [inheritFile]: `import { Node2D } from "godot";
${gdDecl}class Base extends Node2D {}
export default class Derived extends Base {
  @gd.export()
  accessor health: number = 100;
}
`,
  },
  inheritFile,
).text;
check(inheritOut.includes("@gd.class export default class Derived"), "auto-class-via-project-base");

const notDefault = `/virtual/not-default.ts`;
const notDefaultSrc = `import { Node } from "godot";
${gdDecl}export class Helper extends Node {
  @gd.export()
  accessor health: number = 100;
}
export default class Main extends Node {}
`;
mustThrowAt({ [notDefault]: notDefaultSrc }, notDefault, "not the default export", at(notDefault, notDefaultSrc, "@gd.export()"), "error-not-default-export");

const notGodot = `/virtual/not-godot.ts`;
const notGodotSrc = `${gdDecl}export default class Plainly {
  @gd.onready("Label")
  label!: unknown;
}
`;
mustThrowAt({ [notGodot]: notGodotSrc }, notGodot, "does not extend a Godot class", at(notGodot, notGodotSrc, '@gd.onready("Label")'), "error-not-godot-class");

// Ticket 200: an engine base class the stand-in typings do not declare (Area2D) is still an engine class.
const area = `/virtual/area.ts`;
const areaSrc = `import { Area2D, type Signal } from "godot";
${gdDecl}export default class Sugar extends Area2D {
  @gd.export()
  accessor speed: number = 400;
  accessor hit!: Signal<() => void>;
}
`;
const areaOut = compile({ [area]: areaSrc }, area).text;
check(areaOut.includes("gd.class") && areaOut.includes("gd.export"), "area2d-base-builds");
// An exported engine class the stand-in lacks is classified by the generated hierarchy when present; the error says what to do when not.
const resFile = `/virtual/res.ts`;
const resSrc = `import { Node, PackedScene } from "godot";
${gdDecl}export default class Res extends Node {
  @gd.export()
  accessor mob_scene!: PackedScene;
}
`;
let resOut = "";
try {
  resOut = compile({ [resFile]: resSrc }, resFile).text;
} catch (e) {
  resOut = String(e);
}
check(resOut.includes("bun run types") && !resOut.includes("any or unresolved"), "engine-resource-export-without-typings-says-run-types");
// With generated typings (here a two-class fixture) the same field gets the Resource hint.
const typed = mkdtempSync(join(tmpdir(), "engine-classes-"));
mkdirSync(join(typed, "typings"));
writeFileSync(join(typed, "typings", "godot0.gen.d.ts"), "declare module \"godot\" { class Resource extends Object {} class PackedScene extends Resource {} class Node extends Object {} }\n");
setEngineClassRoot(typed);
const typedOut = compile({ [resFile]: resSrc }, resFile).text;
setEngineClassRoot("");
check(typedOut.includes('hint: 17, hint_string: "PackedScene"'), "engine-resource-export-classified-by-generated-typings");

// -- 2. signals declared by type only -----------------------------------------------------
const sigFile = `/virtual/sig.ts`;
const sigSrc = `import { Node, type Signal } from "godot";
export default class Sig extends Node {
  accessor spun!: Signal<(amount: number) => void>;
  accessor done!: Signal<() => void>;
  alias: Signal<() => void> = this.done;
  _ready(): void {
    throw new Error("boom-sig");
  }
}
`;
const sig = compile({ [sigFile]: sigSrc }, sigFile);
check(sig.text.includes("@__gd.signal() accessor spun!") && sig.text.includes("@__gd.signal() accessor done!"), "signal-by-type");
check(!sig.text.includes("@__gd.signal() alias"), "signal-field-with-initializer-left-alone");
check(sig.text.includes('import { gd as __gd } from "/virtual/lib/gd.ts";') && sig.text.includes("@__gd.class export default class Sig"), "signal-injects-gd-import");
const sigIdx = sig.text.indexOf('throw new Error("boom-sig")');
const sigOrig = offsetToPos(sig.map!.map.originalStarts, lookupOriginal(sig.map!.map.ranges, sigIdx)!);
check(sigOrig.line === sigSrc.split("\n").findIndex((l) => l.includes("boom-sig")) + 1, "sourcemap-after-injected-import", `line=${sigOrig.line}`);

const sigGdFile = `/virtual/sig-gd.ts`;
const sigGd = compile(
  {
    [sigGdFile]: `import { Node, type Signal } from "godot";
import { gd } from "./lib/gd";
export default class SigGd extends Node {
  @gd.export()
  accessor n: number = 1;
  accessor spun!: Signal<() => void>;
}
`,
    "/virtual/lib/gd.ts": `export const gd: any = {};\n`,
  },
  sigGdFile,
).text;
check(sigGd.includes("@gd.signal() accessor spun") && !sigGd.includes("__gd"), "signal-uses-imported-gd");

const sigUser = `/virtual/sig-user.ts`;
check(
  compile(
    {
      [sigUser]: `import { Node } from "godot";
interface Signal<T> { x: T }
export default class SigUser extends Node {
  accessor spun!: Signal<number>;
}
`,
    },
    sigUser,
  ).text.includes(".signal(") === false,
  "user-signal-type-is-not-a-signal",
);

const sigNear = `/virtual/sig-near.ts`;
const sigNearSrc = `import { Node, type Signal } from "godot";
export default class SigNear extends Node {
  spun!: Signal<() => void>;
}
`;
mustThrowAt({ [sigNear]: sigNearSrc }, sigNear, "not an `accessor`", at(sigNear, sigNearSrc, "spun!"), "error-signal-not-accessor");

