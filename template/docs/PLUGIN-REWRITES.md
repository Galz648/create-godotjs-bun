# Plugin rewrites

The build plugin (`tools/plugin/`) edits your TypeScript before Bun emits it. Under ADR 0009 (in godotjs-esm) every rewrite must have a documented explicit form, an equivalence test with a negative control, and an off switch. A new rewrite needs a ticket on the tooling map first. Validation (warnings, scene checks, build errors) never edits output and has no switch, except the abort guards below, which have one so code that must build anyway can opt out.

## The table

| Rewrite | What it saves | Switch | Test | Status |
| --- | --- | --- | --- | --- |
| Typed exports | the type id, hint and hint string of `@gd.export()`, and the `export.array` / `export.object` helpers | `exports` | `exports`, `exports-helper` in `self-check/rewrites.ts` | stays |
| `@gd.onready` | a hand-written `_ready` that fetches nodes and calls `super._ready?.()` | `onready` | `onready`, `onready-own-ready` | stays |
| Class registration | `@gd.class` on the class, `@gd.signal()` on a `Signal<...>` accessor | `register` | `register` | stays |
| `@gd.stored` insertion | `@gd.stored("<Class>.<field>")` on every plain accessor (editor reload and hot reload keep its value) | `stored` | `stored` | stays |
| `connect(fn)` wrapping | `Callable.create(...)` around a function passed to `connect`, `disconnect`, `is_connected`, `tween_callback`, `GArray.filter/map`, and the owner-aware `Callable.create(owner, fn)` | `connect` | `connect` | watch list: first to cut if upkeep grows or an upstream fix lands |

## Explicit forms

Each snippet is what you write with the switch off. The plugin leaves these alone with the switch on too.

### `exports`

```ts
// sugar
@gd.export()
accessor hp: number = 10;

// explicit: type id, optional { hint, hint_string }, then the stored key "<Class>.<field>"
@gd.export(2, undefined, undefined, "Player.hp")
@gd.export(24, { hint: 34, hint_string: "Node" }, undefined, "Player.target")   // Node | null
@bind.export(28, { hint: 23, hint_string: "4:" })                             // was bind.export.array(String)
```

Type ids are Godot's `Variant.Type` (2 int, 3 float, 4 String, 24 Object, 28 Array). The fourth argument is optional by hand (`@gd.export(2)` keys the stored slot by field name alone); the equivalence test uses the full form the plugin writes. With the switch off, a bare `@gd.export()` or `export.array(...)` fails the build and prints the exact explicit text for that field.

### `onready`

```ts
// sugar
@gd.onready("Label")
label: Label | null = null;

// explicit: drop the decorator, write _ready (the plugin's generated text, which tolerates a missing node)
_ready(): void {
  try { const __n = this.get_node("Label"); this.label = __n == null ? null : __n; } catch { this.label = null; }
  super._ready?.();
}
```

The usual hand-written shorter form (`this.label = this.get_node("Label") as Label;`) is fine too, but it throws on a missing path where the generated text leaves `null`. The negative control uses it: it does not compare equal. Put the lines at the top of an existing `_ready` instead of generating one. The plugin adds `@gd.class` to a class that has `@onready` fields, so the test's explicit source writes it too (next section).

### `register`

```ts
// sugar
export default class Hero extends Node {
  accessor hit!: Signal<() => void>;
}

// explicit
@gd.class
export default class Hero extends Node {
  @gd.signal() accessor hit!: Signal<() => void>;
}
```

With the switch off, a script class that has `@gd` member decorators but no `@gd.class`, or a Signal-typed accessor with no `@gd.signal()`, fails the build.

### `stored`

```ts
// sugar
accessor count = 0;

// explicit
@gd.stored("Hero.count") accessor count = 0;
```

The engine accepts the plain accessor, so with the switch off there is no diagnostic; you only lose the value surviving a reload. `@gd.export` accessors are stored by the runtime either way.

### `connect`

```ts
// sugar
this.spun.connect((n) => this.onSpun(n));
Callable.create(owner, fn);

// explicit
import { Callable } from "godot";
import { callableWithOwner } from "godotjs-tooling/callable";   // module is served by the plugin even with the switch off
this.spun.connect(Callable.create((n) => this.onSpun(n)));
callableWithOwner(owner, fn);
```

For a named method, `Callable.create(this, "onSpun")` needs no rewrite at any time. With the switch off, passing a plain function to an engine `connect` / `disconnect` / `is_connected` / `tween_callback` / `filter` / `map` fails the build and prints this form. (TypeScript does not know the `godotjs-tooling/callable` module; add a `declare module` if you use it with the switch off.)

## Engine-abort guards (a check, not a rewrite)

Switch: `abortGuards` (default on). Nothing is edited: a build ERROR names the file:line:col, the engine ticket and the safe form. Code: `tools/plugin/abort-checks.ts`. A check fires only when the type is known: from the checker, from the NAME of a class imported from `"godot"` (the stand-in typings declare few classes), or from a `const`, an annotated variable or a parameter. An `any`, an unresolved value, a call result, a `let` or a user class named `Vector2` stays silent. Tickets: the tooling map in godotjs-esm.

| Ticket | Construct that is an error | What the engine does | Safe form |
| --- | --- | --- | --- |
| 80 | `new Vector2/Vector3/Vector4/Rect2(<Vector2i/Vector3i/Vector4i/Rect2i>)`, and the integer types copying themselves: `new Vector2i(v)`, `new Vector3i(v)`, `new Vector4i(v)`, `new Rect2i(r)` | FATAL abort (signal 5) | `new Vector2(v.x, v.y)`; for a rect `new Rect2(r.position.x, r.position.y, r.size.x, r.size.y)` |
| 80 | `new Basis(<Quaternion>)` | signal 11 | `Basis.from_euler(q.get_euler())` |
| 81 | `new GArray(<PackedXArray>)` (all ten Packed types) | process dies | `const a = new GArray(); for (let i = 0; i < p.size(); i++) a.push_back(p.get(i))` |
| 82 | `x.unreference()` on a `RefCounted` (or a subclass the generated typings know) | FATAL, then never exits | do not call it; drop the reference, `weakref()` to watch |
| 83 | `animationNodeTransition.input_count = -1` (a negative literal) | endless error lines, the call never returns | a count of 0 or more |
| 84 | `new GridMapEditorPlugin()`, `new ScriptCreateDialog()` | prints "can only be instantiated by editor", the next call is signal 11 | not from a game script |
| 85 | `Geometry2D.offset_polyline(new PackedVector2Array(), ...)` (inline empty polyline) | signal 11 | check `points.size() > 0` first |

Not caught, because the trigger is not in the source: 86 (a RenderingDevice that only a headless run lacks), a Packed array that is empty at run time, a negative count held in a variable, a `Vector2i` that comes back from an engine call (its type is not known to the plugin), ticket 07 (a freed object read out of a container), ticket 222 (a long run). 87, 88 and 89 are exceptions or missing members, not aborts: nothing to guard.

With the switch off (`"godotjs": { "plugin": { "abortGuards": false } }` or `GODOTJS_PLUGIN_OFF=abortGuards`) the code builds as written and the engine aborts at run time exactly as the table says. The test is `starter/tests/abort-guards/run.sh` (engine): for each construct the guarded build must fail at the marked line, and with the guard off the same code must die or hang on the stock binary (every launch under godotjs-esm's `tools/guard.ts`); the safe forms must build and finish.

## Value-type diagnostics (checks, not rewrites)

Four more pure validations (ADR 0009: a validation is free), one switch each, all on by default, code in `tools/plugin/value-checks.ts` (types of engine members: `engine-members.ts`). They catch SILENT bugs: the code runs and gives a wrong answer. Each fires only when the type is KNOWN (a class imported from `"godot"`, an annotation, a `const`, the checker's stand-in typings, or a member the plugin knows: a built-in list of the common ones, plus every getter and every method returning a value type or a Packed array that the generated typings (`bun run types`, `typings/godot*.gen.d.ts`) declare). A class of the same name that is not imported from `"godot"`, a member your own class declares (also on a subclass of an engine class), an `any` and an unresolved type stay silent. The checks look at every file that imports from `"godot"`, not only files with a trigger word.

| Ticket | Switch | Level | Construct | What the engine does (measured on the stock binary) | Safe form |
| --- | --- | --- | --- | --- | --- |
| 265 | `lostWrites` | warning | `a.b.c = x`, `+=`, `-=`, `++` (any assignment) where `a.b` is a Vector2/3/4(i), Rect2(i), AABB, Basis, Transform2D/3D, Quaternion, Plane, Color or Projection that an engine property or method returned: `this.velocity.y -= g`, `node.rotation.y = x`, `this.scale.x *= 2`, `node.transform.origin.x = 4`, `aabb.position.x = 9`, `t.basis.x.y = 1`, `ctl.get_rect().position.x = 1`; also the members of a value type held in a local (`t.origin.x`) | every read of the property returns a new copy; the write is lost, no error | read into a local, change, assign back: `const v = node.rotation; v.y = x; node.rotation = v;`, or `node.rotation = new Vector3(...)`. A local variable holding the value (`const v = node.position; v.x = 1`), a field of your own class and an array element are fine and not reported |
| 262 | `badConversions` | ERROR | `new Quaternion(<Basis>)`, `new Projection(<Transform3D>)`, `new Transform3D(<Projection>)` | zeros or garbage floats, no error (the binding reads the argument as the constructed type) | `basis.get_rotation_quaternion()`; `new Projection(new Vector4(t.basis.x.x, t.basis.x.y, t.basis.x.z, 0), <y>, <z>, new Vector4(t.origin.x, t.origin.y, t.origin.z, 1))`; `new Transform3D(new Basis(<x.xyz>, <y.xyz>, <z.xyz>), <w.xyz>)` (the error message spells them out). Probed and fine, so not reported: the copy constructors, `Vector3i(Vector3)`, `Rect2i(Rect2)`, `Plane(...)`, `Color(...)`, `Transform3D(Basis)`, `Quaternion(axis, angle)`; the aborting members are `abortGuards` above |
| 267 | `valueStrings` | warning | a value type, Packed array or `NodePath` in a template literal, `String(v)`, `"" + v`, `s += v`, `v.toString()`, `JSON.stringify(v)` (also as a property of an object or array literal passed to it) | `[object Object]` (or `{}` / `{"pos":{}}`); the types have no `toString` | `str(v)` (`import { str } from "godot"`: GDScript's text, `(1.0, 2.5, -3.0)`; works for every type above), `var_to_str(v)` for a parseable `Vector3(1, 2.5, -3)`, `console.log(v)`, or the fields (`${v.x}, ${v.y}`, `JSON.stringify({ x: v.x, y: v.y })`) |
| 268 | `packedIteration` | warning | `for (x of p)`, `[...p]`, `f(...p)`, `const [a] = p`, `Array.from(p)` where `p` is any `Packed*Array` (also a call result such as `curve.get_baked_points()` or `OS.get_cmdline_user_args()`) | `TypeError: value is not iterable`; `Array.from(p)` returns `[]` with no error | `Array.from({ length: p.size() }, (_, i) => p.get(i))` or `for (let i = 0; i < p.size(); i++) { const x = p.get(i); }` (`to_array()` does not exist) |

Not caught, on purpose ("silent rather than wrong"): a value that reaches the line through a generic helper, a `let` that is reassigned, an element of an array, a call whose return type the plugin does not know (no generated typings and not in the built-in list), a Packed array or value type inside another expression the plugin cannot type, `String(v)` through an alias of `String`. Conversions other than the three above that return garbage were not found (probed on the stock binary: the one-argument and two-argument constructors among Vector2/3/4(i), Rect2(i), AABB, Plane, Basis, Transform2D/3D, Projection, Quaternion, Color; the rest equal GDScript, `new Basis(<Quaternion>)` and `new Vector3(<Vector3i>)` abort and are `abortGuards`).

Off: `"godotjs": { "plugin": { "lostWrites": false } }` (likewise `badConversions`, `valueStrings`, `packedIteration`, and the leak warnings below) or `GODOTJS_PLUGIN_OFF=lostWrites,badConversions,valueStrings,packedIteration`. The warning text ends with the switch's name. Tests: `tools/plugin/self-check/value-checks.ts` (no engine: positive cases at their original file:line:col, controls that must stay silent: the safe form, a local variable, a user class or user field of the same name, a non-engine import, an untyped value, switch off) and `starter/tests/value-diagnostics/run.sh` (engine: the build warns at exactly the lines marked `// LOST` / `// TEXT` / `// PACKED`, the three `bad-*.ts` fail the build, and on the stock binary every flagged construct really misbehaves, each with a twin that writes or converts the safe way and works; control: every switch off is silent, `ZZ_CONTROL=1` inverts the assertions).

## Leak and bloat warnings (checks, not rewrites)

Three more pure validations (ticket 441), one switch each, all on by default, code in `tools/plugin/leak-checks.ts`. They name code that runs but leaks engine objects for the whole session (the leak family: `docs/DAILY.md`, "Engine-returned objects leak") or bloats every script bundle. Warnings only: the output is never changed and the build never fails.

| Switch | Construct | Safe form |
| --- | --- | --- |
| `effectBarrel` | a value import or re-export of the barrel `"effect"` (`import { Effect } from "effect"`, `import * as E from "effect"`, `import "effect"`, `export { X } from "effect"`); type-only imports are erased and stay silent | `import * as Effect from "effect/Effect"`, one namespace per subpath |
| `leakCalls` | a call to `create_timer`, `create_tween`, `get_slide_collision` or `get_last_slide_collision` that the project does not declare itself | `setTimeout`, `Effect.sleep`, `FrameClock.sleepCounting`, a Timer node; `tweenProperty()` and `slideCollisions()` from `src/lib/leak-free.ts` |
| `inputVirtuals` | an `_input` or `_unhandled_input` method on a class that extends a Godot class | `onInputEvent(this, (ev) => ...)` from `src/lib/leak-free.ts` in `_ready`, or poll `Input` in `_process` |

One file opts out with a comment anywhere in it: `// godotjs-plugin-allow: leakCalls inputVirtuals` (switch names, space or comma separated). The repository's tests and probes that leak on purpose carry that line at their end. Tests: `tools/plugin/self-check/leak-checks.ts` (no engine: positive cases at their exact file:line:col; controls that must stay silent: a subpath or type-only import, a user class with its own `create_tween`, a class that does not extend a Godot class, the GDScript text inside a string, the safe forms, each switch off, the file opt-out).

## Switching one off

Standing choice for a project, in `package.json`:

```json
{ "godotjs": { "plugin": { "connect": false } } }
```

Per shell or CI, which overrides the file (a comma list of switches to turn off, or `all`): `GODOTJS_PLUGIN_OFF=exports,connect bun run build`. `GODOTJS_NO_STORED=1` still works and means `stored` off. A name that is not a switch is an error, so a typo cannot do nothing. `bun run dev` builds through the same code, so it follows the same settings. Code: `tools/plugin/options.ts`.

## Tests

- `tools/plugin/self-check/rewrites.ts` (no engine): for each rewrite, the explicit source compiled with that one switch off must produce the same transformed text as the sugar source with everything on. "Same" ignores source-map offsets (they are not in the text) and layout: whitespace runs collapse and spaces next to `{ } ( ) , ;` drop, because generated text is glued on without indentation. Tokens and strings compare exactly. A deliberately different explicit form (wrong type id, wrong hint string, missing wrap argument, hand-written `_ready` without the null guard, wrong stored key, different signal type) must not compare equal: that is the negative control. The same file checks that each switch off fails the build with the explicit text, and that the switch settings resolve.
- `starter/tests/rewrites-off/run.sh` (engine, in `run-tooling.sh`): a project with every construct in its explicit form, built with `GODOTJS_PLUGIN_OFF=all`, runs on the stock binary; a sugar file added to the same build must fail with the explicit form named.
- `tools/plugin/self-check/abort-guards.ts` (no engine): every guard has positive cases (original file:line:col, ticket, safe form named) and controls that must not fire (the safe form, a user class named `Vector2`, a non-engine import, an `any`, a `let`, the switch off).
- `tools/plugin/self-check/value-checks.ts` (no engine) and `starter/tests/value-diagnostics/run.sh` (engine): the value-type diagnostics above.
- Defaults are unchanged by the switches: in godotjs-esm, `bun tools/verify.ts --quick` still matches `starter/tests/bundle-baseline.json`.
