import { createClassBinder, type ClassBinder } from "godot.annotations";

// Runtime half of the build plugin (tools/plugin). The plugin reads field types and
// numeric literal tokens, then rewrites `@gd.export()` into `@gd.export(type, options)`.
// It strips `@gd.onready(...)` and assigns the node at the start of `_ready`.
// A bare `@gd.export()` or `@gd.onready()` that was not rewritten throws here.

type Dec = (value: any, context: any) => any;
type HintBag = { hint?: number; hint_string?: string };

let pending: ClassBinder | undefined;

function binder(): ClassBinder {
  if (!pending) pending = createClassBinder();
  return pending;
}

function takeBinder(): ClassBinder {
  const current = pending ?? createClassBinder();
  pending = undefined;
  return current;
}

// Accessor storage that survives an editor reload (docs/design/accessor-reload.md). The TS lowering of
// `accessor` keeps the value in a WeakMap private to one module evaluation; a reload swaps the live
// instances onto a new class with a fresh WeakMap, so the old value is unreachable. These helpers keep the
// value on the instance itself, under a key that does not depend on module identity: a hidden
// (non-enumerable) own property keyed by Symbol.for("godotjs.accessor:<key>").
// A missing slot normally throws, like a skipped constructor does with a plain accessor. One exception, dev
// only (src/lib/hot-reload.ts): an accessor ADDED by a hot swap is missing on every live instance, because the
// constructor does not re-run. The hot-reload library constructs one throwaway instance of the new class with
// `probe` set, which records the value each stored initialiser produced; a miss then initialises the slot from
// that default (a fresh probe per miss for object values, so instances never share an array). Outside a swap
// `defaults` is empty and nothing here changes. Everything shared with hot-reload.ts lives on one globalThis
// object because each bundle carries its own copy of this file.
type HotStored = {
  seen: Set<string>; // every stored key any module evaluation registered
  fresh: string[]; // keys first registered since hot-reload last cleared this list (the keys a swap added)
  probe: Map<string, unknown> | null; // set only while hot-reload constructs its throwaway instance
  defaults: Map<string, { value: unknown; make?: () => unknown }>;
};

function hotStored(): HotStored {
  const g = globalThis as any;
  const k = Symbol.for("godotjs.stored-hot");
  return (g[k] ??= { seen: new Set(), fresh: [], probe: null, defaults: new Map() } satisfies HotStored);
}

function slotSymbol(key: string): symbol {
  return Symbol.for("godotjs.accessor:" + key);
}

function slotMissing(key: string): never {
  throw new TypeError("accessor " + key + " was never initialised on this object");
}

function slotInit(self: object, sym: symbol, v: unknown): unknown {
  if (Object.prototype.hasOwnProperty.call(self, sym)) (self as any)[sym] = v;
  else Object.defineProperty(self, sym, { value: v, writable: true, enumerable: false, configurable: true });
  return v;
}

/** The slot is missing: fill it from a hot-swap default if one exists, else throw. */
function slotFallback(self: object, sym: symbol, key: string): void {
  const d = hotStored().defaults.get(key);
  if (!d) slotMissing(key);
  slotInit(self, sym, d.make ? d.make() : d.value);
}

function slotGet(self: object, sym: symbol, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(self, sym)) slotFallback(self, sym, key);
  return (self as any)[sym];
}

function slotSet(self: object, sym: symbol, key: string, v: unknown): void {
  if (!Object.prototype.hasOwnProperty.call(self, sym)) slotFallback(self, sym, key);
  (self as any)[sym] = v;
}

/** Accessor decorator: keeps `accessor` syntax, stores the value on the instance (see above). Innermost position. */
function stored(key: string): Dec {
  const sym = slotSymbol(key);
  const hot = hotStored();
  if (!hot.seen.has(key)) {
    hot.seen.add(key);
    hot.fresh.push(key);
  }
  return (_target, context) => {
    if (context?.kind !== "accessor") throw new Error("@gd.stored() only decorates an `accessor` field.");
    return {
      get(this: object) {
        return slotGet(this, sym, key);
      },
      set(this: object, v: unknown) {
        slotSet(this, sym, key, v);
      },
      init(this: object, v: unknown) {
        hotStored().probe?.set(key, v);
        return slotInit(this, sym, v);
      },
    };
  };
}

function emit(type: number, hint?: number | HintBag, hintString?: string, owner?: string): Dec {
  let hintNum: number | undefined;
  let hintText: string | undefined;
  if (typeof hint === "number") {
    hintNum = hint;
    hintText = hintString;
  } else if (hint) {
    hintNum = hint.hint;
    hintText = hint.hint_string;
  }
  return (target, context) => {
    const options = hintNum === undefined ? undefined : { hint: hintNum, hint_string: hintText ?? "" };
    binder().export(type, options)(target, context);
    // An exported accessor is stored on the instance so it survives an editor reload. `owner` is the key the
    // plugin passes, "<Class>.<field>"; a hand-written call without it falls back to the field name.
    if (context?.kind === "accessor") return stored(owner ?? String(context.name))(target, context);
  };
}

function exportDec(type?: number, hint?: number | HintBag, hintString?: string, owner?: string): Dec {
  if (typeof type !== "number") {
    throw new Error("@gd.export() was not rewritten. Run `bun run build` so the tooling plugin can read the field type.");
  }
  return emit(type, hint, hintString, owner);
}

const TYPE_INT = 2;
const TYPE_FLOAT = 3;

function intExport(): Dec {
  return emit(TYPE_INT);
}

function floatExport(): Dec {
  return emit(TYPE_FLOAT);
}

function applyClass(target: unknown, context: unknown): void {
  // createClassBinder() is a factory: calling the binder returns the class decorator
  // that writes the properties collected by the member decorators.
  const bind = takeBinder() as unknown as () => Dec;
  bind()(target, context);
}

function classDecorator(target: unknown, context: ClassDecoratorContext): void;
function classDecorator(): Dec;
function classDecorator(target?: unknown, context?: ClassDecoratorContext): void | Dec {
  if (context === undefined) return (ctor, ctx) => applyClass(ctor, ctx);
  applyClass(target, context);
}

function onready(_path: string | ((self: unknown) => unknown)): Dec {
  return () => {
    throw new Error("@gd.onready() was not rewritten. Run `bun run build` so the tooling plugin can assign the node in _ready.");
  };
}

function signalDec(): Dec {
  return (target, context) => {
    binder().signal()(target, context);
  };
}

export const gd = {
  class: classDecorator,
  export: Object.assign(exportDec, { int: intExport, float: floatExport }),
  onready,
  signal: signalDec,
  stored,
};
