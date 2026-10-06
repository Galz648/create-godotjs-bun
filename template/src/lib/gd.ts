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

function emit(type: number, hint?: number | HintBag, hintString?: string): Dec {
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
  };
}

function exportDec(type?: number, hint?: number | HintBag, hintString?: string): Dec {
  if (typeof type !== "number") {
    throw new Error("@gd.export() was not rewritten. Run `bun run build` so the tooling plugin can read the field type.");
  }
  return emit(type, hint, hintString);
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
};
