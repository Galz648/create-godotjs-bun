// Exports, @onready and connect() wrapping.
import ts from "typescript";
import { lookupOriginal, offsetToPos } from "../sourcemap.ts";
import { check, compile, mustThrow } from "./harness.ts";

const header = `import { IntegerType, Node, Node2D, Resource } from "godot";
import { createClassBinder } from "godot.annotations";
const bind = createClassBinder();
`;

const exportsFile = `/virtual/exports.ts`;
const exportsSrc = `${header}
@bind()
export default class Probe extends Node {
  @bind.export.array(String)
  accessor tags: string[] = [];
  @bind.export.array(Resource)
  accessor items: Resource[] = [];
  @bind.export.array(IntegerType)
  accessor scores: number[] = [];
  @bind.export.object(Resource)
  accessor note: Resource | null = null;
  @bind.export.object(Node)
  accessor marker: Node | null = null;
  @bind.export.object(Node2D)
  accessor sprite: Node2D | null = null;
  @bind.export.array(Node)
  accessor markers: Node[] = [];
}
`;
const exported = compile({ [exportsFile]: exportsSrc }, exportsFile).text;
check(exported.includes("hint: 23, hint_string: \"4:\""), "array-string");
check(exported.includes("hint: 23, hint_string: \"24/17:Resource\""), "array-resource");
check(exported.includes("hint: 23, hint_string: \"2:\""), "array-int");
check(exported.includes("hint: 17, hint_string: \"Resource\""), "object-resource");
check(exported.includes("hint: 34, hint_string: \"Node\""), "object-node");
check(exported.includes("hint: 34, hint_string: \"Node2D\""), "object-node2d");
check(exported.includes("hint: 23, hint_string: \"24/34:Node\""), "array-node");
check(!exported.includes(".array(") && !exported.includes(".object("), "helpers-rewritten");

const personFile = `/virtual/person.ts`;
const personSrc = `${header.replace("IntegerType, ", "")}
@bind()
export default class Person extends Resource {}
`;
const probePerson = `/virtual/probe-person.ts`;
const probePersonSrc = `import { Node } from "godot";
import { createClassBinder } from "godot.annotations";
import Person from "./person";
const bind = createClassBinder();
@bind()
export default class Probe extends Node {
  @bind.export.object(Person)
  accessor person: Person | null = null;
  @bind.export.array(Person)
  accessor people: Person[] = [];
}
`;
const personOut = compile(
  { [personFile]: personSrc, [probePerson]: probePersonSrc },
  probePerson,
).text;
check(personOut.includes("hint: 17, hint_string: \"Person\""), "object-person");
check(personOut.includes("hint: 23, hint_string: \"24/17:Person\""), "array-person");

const anyFile = `/virtual/any.ts`;
mustThrow(
  {
    [anyFile]: `${header}
const Mystery: any = Resource;
@bind()
export default class Probe extends Node {
  @bind.export.object(Mystery)
  accessor note: Resource | null = null;
}
`,
  },
  anyFile,
  "any or unresolved",
  "error-any",
);

const genericFile = `/virtual/generic.ts`;
mustThrow(
  {
    [genericFile]: `${header}
class Box<T> extends Resource {}
@bind()
export default class Probe extends Node {
  @bind.export.object(Box)
  accessor note: Resource | null = null;
}
`,
  },
  genericFile,
  "generic",
  "error-generic",
);

const gdFile = `/virtual/gd.ts`;
const gdSrc = `import { Node, Resource } from "godot";
declare const gd: { export: ((type?: number, hint?: object) => unknown) & { class?: unknown }; class: unknown };
@gd.class
export default class Syntax extends Node {
  @gd.export()
  accessor speed: number = 200.0;
  @gd.export()
  accessor health: number = 100;
  @gd.export()
  accessor tags: string[] = [];
  @gd.export()
  accessor note: Resource | null = null;
  @gd.export()
  accessor marker: Node | null = null;
}
`;
const gdOut = compile({ [gdFile]: gdSrc }, gdFile).text;
check(/gd\.export\(3, undefined, undefined, "\w+\.speed"\)/.test(gdOut) && gdOut.includes("speed"), "gd-float-literal", "200.0");
check(/gd\.export\(2, undefined, undefined, "\w+\.\w+"\)/.test(gdOut), "gd-int-literal");
check(gdOut.includes("hint_string: \"4:\""), "gd-string-array");
check(gdOut.includes("hint: 17, hint_string: \"Resource\""), "gd-resource");
check(gdOut.includes("hint: 34, hint_string: \"Node\""), "gd-node");

const numArray = `/virtual/num-array.ts`;
mustThrow(
  {
    [numArray]: `import { Node } from "godot";
declare const gd: { export: () => unknown; class: unknown };
@gd.class
export default class Syntax extends Node {
  @gd.export()
  accessor scores: number[] = [];
}
`,
  },
  numArray,
  "ambiguous",
  "error-number-array",
);

const onreadyFile = `/virtual/onready.ts`;
const onreadySrc = `import { Node } from "godot";
import { createClassBinder } from "godot.annotations";
const bind = createClassBinder();
@bind()
export default class Missing extends Node {
  @bind.onready("Child")
  child!: Node;

  @bind.onready("Missing")
  missing!: Node;

  @bind.onready("Child/Nested")
  nested!: Node;

  @bind.onready((_self: unknown) => {
    throw new Error("onready-boom");
  })
  boom!: Node;

  _ready(): void {
    throw new Error("boom-map");
  }
}
`;
const onready = compile({ [onreadyFile]: onreadySrc }, onreadyFile);
check(!onready.text.includes(".onready("), "onready-stripped");
check(onready.text.includes('get_node("Child")') && onready.text.includes('get_node("Missing")') && onready.text.includes('get_node("Child/Nested")'), "onready-order");
check(onready.text.includes("something wrong when evaluating onready 'boom'"), "onready-warn-text");
const throwIdx = onready.text.indexOf('throw new Error("boom-map")');
const origOff = lookupOriginal(onready.map!.map.ranges, throwIdx);
const origPos = offsetToPos(onready.map!.map.originalStarts, origOff!);
const wantLine = onreadySrc.split("\n").findIndex((line) => line.includes('throw new Error("boom-map")')) + 1;
check(origPos.line === wantLine, "sourcemap-throw-line", `got=${origPos.line} want=${wantLine} col=${origPos.col}`);

const connectFile = `/virtual/connect.ts`;
const connectSrc = `import { Callable, Node, type Signal } from "godot";
import { createClassBinder } from "godot.annotations";
const bind = createClassBinder();
@bind()
export default class Probe extends Node {
  @bind.signal()
  accessor ping!: Signal<(n: number) => void>;
  _ready(): void {
    const fn = (n: number) => n;
    const other = (n: number) => n;
    this.ping.connect(fn);
    this.ping.is_connected(other);
    this.ping.disconnect(fn);
    this.ping.connect(fn, 4);
    this.ping.is_connected(Callable.create(fn));
    const node = new Node();
    this.ping.is_connected(Callable.create(node, fn));
    this.connect("ping", fn);
    this.create_tween().tween_callback(() => {});
  }
  create_tween(): { tween_callback(fn: () => void): void } { return { tween_callback() {} }; }
}
`;
const connectOut = compile({ [connectFile]: connectSrc }, connectFile).text;
check(connectOut.includes("this.ping.connect(Callable.create(fn))"), "connect-wrap");
check(connectOut.includes("this.ping.connect(Callable.create(fn), 4)"), "connect-flags");
check(connectOut.includes("is_connected(Callable.create(other))"), "is-connected-wrap");
check(connectOut.includes("disconnect(Callable.create(fn))"), "disconnect-wrap");
check(connectOut.includes("is_connected(Callable.create(fn))"), "create-not-double");
check(!connectOut.includes("Callable.create(Callable.create"), "no-double-wrap");
check(connectOut.includes("callableWithOwner(node, fn)"), "owner-eq");
check(connectOut.includes('this.connect("ping", Callable.create(fn))'), "object-connect");
check(connectOut.includes("tween_callback(Callable.create(() => {}))"), "tween");
check(!connectOut.includes(".connect(fn)") && !connectOut.includes(".connect(other)"), "no-bare-fn-connect");

// `boolean` is the union `true | false` to the type checker. It once failed with "cannot yet split a union".
for (const [label, field] of [
  ["export-boolean", "accessor armed: boolean = true;"],
  ["export-boolean-or-null", "accessor armed: boolean | null = null;"],
] as const) {
  const src = `import { Node } from "godot";\nimport { gd } from "./lib/gd";\nexport default class A extends Node {\n  @gd.export()\n  ${field}\n}\n`;
  try {
    const out = compile({ "/virtual/bool.ts": src, "/virtual/lib/gd.ts": "export const gd: any = {};\n" }, "/virtual/bool.ts").text;
    check(out.includes('@gd.export(1, undefined, undefined, "A.armed")'), label);
  } catch (e) {
    check(false, label, String(e).split("\n")[0]);
  }
}
