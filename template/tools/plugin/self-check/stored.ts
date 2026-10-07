// Accessor storage for reload (docs/design/accessor-reload.md).
import ts from "typescript";
import { lookupOriginal, offsetToPos } from "../sourcemap.ts";
import { check, compile } from "./harness.ts";

// -- storage for reload (docs/design/accessor-reload.md) -------------------------------------
const stFile = `/virtual/st.ts`;
const stSrc = `import { Node, type Signal } from "godot";
import { gd } from "./lib/gd";
import { createClassBinder } from "godot.annotations";
const bind = createClassBinder();
export default class St extends Node {
  @gd.export()
  accessor hp: number = 10;
  @gd.export(2, { hint: 1, hint_string: "0,9" } as any)
  accessor already: number = 1;
  accessor count = 0;
  @bind.cache()
  accessor cached = 1;
  @bind.export(2)
  accessor raw = 1;
  accessor spun!: Signal<() => void>;
  accessor boom = (() => { throw new Error("boom-stored"); })();
}
`;
const st = compile({ [stFile]: stSrc, "/virtual/lib/gd.ts": `export const gd: any = {};\n` }, stFile);
check(st.text.includes('@gd.export(2, undefined, undefined, "St.hp")'), "export-passes-owner-tag", "");
check(st.text.includes('accessor count') && st.text.includes('@gd.stored("St.count") accessor count'), "stored-inserted-on-plain-accessor");
check(/@bind\.cache\(\) @gd\.stored\("St\.cached"\)\s+accessor cached/.test(st.text),"stored-after-last-decorator");
check(!st.text.includes("St.raw") && !st.text.includes("St.spun") && !st.text.includes("St.already"), "stored-skips-bind-export-signal-and-explicit-export");
const boomAt = st.text.indexOf('throw new Error("boom-stored")');
const boomOrig = offsetToPos(st.map!.map.originalStarts, lookupOriginal(st.map!.map.ranges, boomAt)!);
check(boomOrig.line === stSrc.split("\n").findIndex((l) => l.includes("boom-stored")) + 1, "sourcemap-after-stored-insertions", `line=${boomOrig.line}`);

const twoFile = `/virtual/two.ts`;
const twoSrc = `import { Node } from "godot";
import { gd } from "./lib/gd";
class Other extends Node {
  @gd.stored("Other.v") accessor v = 1;
}
export default class Two extends Node {
  accessor n = 0;
}
export { Other };
`;
const two = compile({ [twoFile]: twoSrc, "/virtual/lib/gd.ts": `export const gd: any = {};\n` }, twoFile);
// Several decorated classes in one file: Bun's identifier renaming (tools/build.ts) keeps their lowering temporaries apart, see docs/design/cross-file-decorators.md.
check(two.text.includes('stored("Two.n")') && !(two.map?.warnings ?? []).some((w) => w.includes("another class in this file is decorated")), "stored-applied-when-file-has-other-decorated-class");

