// hot(name, cls): keep instances of a plain (non-Godot) class alive across a `bun run dev` hot reload
// (src/lib/hot-reload.ts). Script classes swap by themselves; a plain logic class, say one under src/lib/sim,
// does not: re-evaluating a bundle makes a NEW class object while instances made earlier still point at the
// OLD prototype. Wrap the class once:
//
//   export const Sim = hot("Sim", class Sim { ... });      // or: class Sim {...}; export default hot("Sim", Sim);
//
// On the second evaluation of a name, the old prototype loses its own members and inherits from the new
// prototype, so existing instances run the new method bodies, keep their own data (class fields), and
// `x instanceof NewClass` is true for them. Outside a reload it is one Map lookup at class definition.
//
// Rules: the name is the identity, so keep it unique per class and import the class from ONE script bundle (two
// bundles that both contain the class would re-point each other's instances at startup). Do not use `#private`
// fields or `accessor` in a hot class (new methods cannot read a private slot an old instance never got; use
// TypeScript `private`). Statics are not carried over (the new class has its own). A field ADDED by the edit is
// `undefined` on old instances: constructors do not re-run. Closures made earlier still run old code: see the
// thin closure rule in docs/DAILY.md. Design: docs/design/hot-reload.md.
//
// The runner (tools/dev.ts) also uses hot() as the proof that an edited plain module is live: the module counts as
// reloaded only when it registers a class here (the hot-reload ack lists the registered names). And when the runner says
// a module that declares a hot class changed, the swap builds one throwaway instance of the old class (during the swap) and of the new one (after it) and
// compares the data shape of both (keys and value types, src/lib/shape.ts); a different shape asks for the restart, so a
// field the edit ADDED is never `undefined` in live state. A class that cannot be built without arguments is not checked.
import { fits, plainData, shapeOf } from "./shape";

const registry: Map<string, Function> = ((globalThis as any)[Symbol.for("godotjs.hot")] ??= new Map());

type Probe = { names: Set<string>; later: (() => string | null)[] };

/** Called while the swap evaluates the new module: the old shape now (the old class is still intact), the new one afterwards. */
function planShapeCheck(probe: Probe, name: string, old: Function, next: Function): void {
  let before;
  try { before = shapeOf(plainData(new (old as any)())); } catch { return; } // cannot be built without arguments: not checked
  probe.later.push(() => {
    try {
      return fits(before, shapeOf(plainData(new (next as any)()))) ? null : `state shape of ${name} changed`;
    } catch {
      return null;
    }
  });
}

export function hot<T extends Function>(name: string, cls: T): T {
  const old = registry.get(name);
  registry.set(name, cls);
  const probe = (globalThis as any)[Symbol.for("godotjs.hot.probe")] as Probe | undefined;
  if (old && old !== cls && probe?.names.has(name)) planShapeCheck(probe, name, old, cls);
  if (old && old !== cls) {
    for (const key of Reflect.ownKeys(old.prototype)) if (key !== "constructor") delete (old.prototype as any)[key];
    Object.setPrototypeOf(old.prototype, cls.prototype);
  }
  return cls;
}
