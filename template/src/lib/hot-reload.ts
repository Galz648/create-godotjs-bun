// Dev-only in-process hot reload of script classes. Install: call hotReload() once from the main scene root's
// _ready (src/main.ts). With GODOTJS_DEV_STATE unset (exports, `bun run start`, the editor) hotReload() does
// nothing: no timer, no file access. The runner (tools/dev.ts) writes <dir>/reload-request.json
// {token, scripts: ["res://src/x.ts", ...]}; this answers with <dir>/reload-ack.json {token, ok, hot, restart}.
// It uses the engine's own reload path (Script.reload(true) re-evaluates the bundle and rebinds live
// instances onto the new prototype), then checks that nothing changed that a live instance cannot follow (a removed or
// retyped property, an added plain field, signals, base, engine virtuals) and gives accessors the swap ADDED their default (stage 2, below).
// Design: docs/design/hot-reload.md.

import { devStateListen } from "./dev-state";

const engine = require("godot") as {
  OS: { get_environment(name: string): string };
  FileAccess: {
    file_exists(path: string): boolean;
    open(path: string, flags: number): { get_as_text(): string; store_string(text: string): boolean; close(): void } | null;
  };
  ResourceLoader: { load(path: string): any };
};

const dir = String(engine.OS.get_environment("GODOTJS_DEV_STATE") ?? "").trim();
const KEY = Symbol.for("godotjs.hot-reload");
const POLL_MS = 50;

function readText(path: string): string | undefined {
  if (!engine.FileAccess.file_exists(path)) return undefined;
  const file = engine.FileAccess.open(path, 1);
  if (!file) return undefined;
  const text = file.get_as_text();
  file.close();
  return text;
}

function writeText(path: string, text: string): void {
  const file = engine.FileAccess.open(path, 2);
  if (!file) return;
  file.store_string(text);
  file.close();
}

/** A Godot Array of Dictionaries (property, signal and method lists) as name -> type, sorted by name. */
function entries(list: any): Map<string, string> {
  const out: [string, string][] = [];
  for (let i = 0; i < list.size(); i++) {
    const d = list.get(i);
    out.push([String(d.get("name")), String(d.get("type"))]);
  }
  return new Map(out.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)));
}

type Shape = { props: Map<string, string>; signals: string; virtuals: string; base: string };

/** What a live instance cannot follow: removed or retyped properties, signals, the base type, and engine virtuals. */
function shape(script: any): Shape {
  const list = (l: any) => [...entries(l).keys()].join(",");
  return {
    props: entries(script.get_script_property_list()),
    signals: list(script.get_script_signal_list()),
    virtuals: list(script.get_script_method_list()).split(",").filter((n) => n.startsWith("_") && n !== "_init").join(","),
    base: String(script.get_instance_base_type()),
  };
}

/** Why the new shape cannot be followed live, or null. ADDED properties are fine (stage 2, see below); anything else is not. */
function shapeProblem(before: Shape, after: Shape): string | null {
  for (const [name, type] of before.props) {
    if (!after.props.has(name)) return `property ${name} was removed`;
    if (after.props.get(name) !== type) return `property ${name} changed type`;
  }
  if (before.signals !== after.signals) return "signals changed";
  if (before.virtuals !== after.virtuals) return "engine virtuals changed";
  if (before.base !== after.base) return "base class changed";
  return null;
}

// Stage 2: a @gd.stored accessor (every @gd.export accessor and every plain accessor of a script class) that the
// new module added exists on the new prototype, but each live instance has no slot for it: the constructor does not
// re-run. gd.ts records which keys the swap registered (`fresh`). We construct ONE throwaway instance of the new
// class with `probe` set, so each stored initialiser reports the value it produced, and store those as defaults that
// gd.ts hands to a live instance on its first read or write of the new accessor. The engine side needs nothing:
// a new export shows up in the script property list by itself (checked on the stock binary) and the engine reads
// it through the accessor. Cost and limits: the new class' constructor runs once more (field initialisers, `_init`
// side effects). A plain non-accessor field added by the edit would stay `undefined`, so the same probe also drives
// the field check below (stage 2b): such a swap asks for the restart.
type HotStored = {
  fresh: string[];
  probe: Map<string, unknown> | null;
  defaults: Map<string, { value: unknown; make?: () => unknown }>;
};

function storedState(): HotStored {
  return ((globalThis as any)[Symbol.for("godotjs.stored-hot")] ??= { seen: new Set(), fresh: [], probe: null, defaults: new Map() });
}

/** What one throwaway instance told us: the value each stored initialiser produced, and the own enumerable field keys. */
type Probe = { values: Map<string, unknown>; fields: Set<string> };

function construct(script: any): Probe {
  const hot = storedState();
  const values = new Map<string, unknown>();
  const fields = new Set<string>();
  hot.probe = values;
  try {
    const instance = script.call("new");
    if (instance === null || instance === undefined) throw new Error("new() returned nothing");
    // Own enumerable string keys only: the hidden stored slots are non-enumerable symbols, methods live on the prototype.
    for (const key of Object.keys(instance)) fields.add(key);
    if (typeof instance.free === "function" && !instance.is_class("RefCounted")) instance.free();
  } finally {
    hot.probe = null;
  }
  return { values, fields };
}

/** Own-field keys of a throwaway instance, or null when it cannot be built (constructor arguments, plain-class module). */
function tryProbe(script: any): Probe | null {
  try { return construct(script); } catch { return null; }
}

/** Plain-field baseline per script path: the keys the last probe of that script had (docs/design/hot-reload.md, stage 2b). */
function baselines(): Map<string, Set<string>> {
  const g = globalThis as any;
  const k = Symbol.for("godotjs.hot-reload.fields");
  return (g[k] ??= new Map());
}

/** The first own field the new class has and the old one did not, or null. Removed fields are ignored on purpose. */
function addedField(before: Set<string>, after: Set<string>): string | null {
  for (const key of after) if (!before.has(key)) return key;
  return null;
}

/** Record defaults for the keys this swap added, from an already built probe. */
function addDefaults(script: any, probe: Probe, keys: string[]): void {
  const hot = storedState();
  for (const key of keys) {
    if (!probe.values.has(key)) continue; // registered by a class this script never constructs: nothing to default
    const value = probe.values.get(key);
    const plain = value === null || (typeof value !== "object" && typeof value !== "function");
    hot.defaults.set(key, plain ? { value } : { value, make: () => construct(script).values.get(key) });
  }
}

type Ack = { token: string; ok: boolean; hot: string[]; restart: string | null; hotNames: string[] };

/** The names of classes registered through hot() (src/lib/hot.ts): the runner uses them to tell which plain modules are live. */
function hotNames(): string[] {
  const registry = (globalThis as any)[Symbol.for("godotjs.hot")] as Map<string, unknown> | undefined;
  return registry ? [...registry.keys()] : [];
}

/** Evaluate the scripts again. `probe` names the hot() classes whose module changed: their data shape is compared across the swap. */
function reload(paths: string[], probe: string[]): Ack {
  const ack: Ack = { token: "", ok: true, hot: [], restart: null, hotNames: [] };
  const hotProbe = { names: new Set(probe), later: [] as (() => string | null)[] };
  (globalThis as any)[Symbol.for("godotjs.hot.probe")] = hotProbe;
  try {
    swapScripts(paths, ack);
    // Stage 3b: the new module code has run; a hot() class whose instances changed data shape cannot be followed live.
    if (ack.restart === null) for (const check of hotProbe.later) { const problem = check(); if (problem) { ack.restart = problem; break; } }
  } finally {
    delete (globalThis as any)[Symbol.for("godotjs.hot.probe")];
  }
  ack.ok = ack.restart === null;
  ack.hotNames = hotNames();
  return ack;
}

function swapScripts(paths: string[], ack: Ack): void {
  for (const path of paths) {
    const script = engine.ResourceLoader.load(path);
    if (!script) { ack.restart = `${path}: could not load the script`; break; }
    const before = shape(script);
    // Baseline of own fields BEFORE the reload: the probe of the previous swap, else a probe of the old class now.
    const known = baselines();
    const oldFields = known.get(path) ?? tryProbe(script)?.fields ?? null;
    storedState().fresh.length = 0;
    const err = script.reload(true);
    if (err !== 0) { ack.restart = `${path}: reload returned ${String(err)} (an earlier evaluation failed)`; break; }
    if (!script.can_instantiate()) { ack.restart = `${path}: the new module threw while evaluating`; break; }
    const problem = shapeProblem(before, shape(script));
    if (problem) { ack.restart = `${path}: ${problem}`; break; }
    const fresh = storedState().fresh.splice(0);
    const probe = tryProbe(script);
    if (probe === null) {
      known.delete(path);
      if (fresh.length > 0) { ack.restart = `${path}: could not construct a probe instance for the new accessors`; break; }
    } else {
      // A plain field the new class has and live instances do not: nothing would ever initialise it.
      const added = oldFields === null ? null : addedField(oldFields, probe.fields);
      if (added !== null) { known.delete(path); ack.restart = `${path}: field added: ${added}`; break; }
      known.set(path, probe.fields);
      if (fresh.length > 0) addDefaults(script, probe, fresh);
    }
    ack.hot.push(path);
  }
}

function state(): { handler: () => void; timer: unknown; lastToken: string } {
  return (globalThis as any)[KEY];
}

function poll(): void {
  const text = readText(`${dir}/reload-request.json`);
  if (text === undefined) return;
  let request: { token?: string; scripts?: string[]; probe?: string[] };
  try { request = JSON.parse(text); } catch { return; } // half written: next tick
  if (!request.token || request.token === state().lastToken) return;
  state().lastToken = request.token;
  const ack = reload(request.scripts ?? [], request.probe ?? []);
  ack.token = request.token;
  console.log(`hot-reload t=${Date.now()}: ${ack.ok ? `swapped ${ack.hot.length} script(s)` : `restart needed: ${ack.restart}`}`);
  writeText(`${dir}/reload-ack.json`, JSON.stringify(ack));
}

/** Call once from a script that lives for the whole run (the main scene root). Idempotent across reloads of the caller. */
export function hotReload(): void {
  if (dir === "") return;
  devStateListen(); // answer save requests even in a scene with no devState(): the runner learns the scene to relaunch into
  const g = globalThis as any;
  // One interval for the whole process. The newest module evaluation replaces the handler, so a reloaded caller runs new code.
  // lastToken lives on the same shared object, so a reloaded caller does not replay the request that reloaded it,
  // and a fresh process starts past any request an earlier process left behind.
  if (!g[KEY]) {
    let lastToken = "";
    try { lastToken = String(JSON.parse(readText(`${dir}/reload-request.json`) ?? "{}").token ?? ""); } catch { /* none */ }
    g[KEY] = { handler: poll, lastToken, timer: setInterval(() => g[KEY].handler(), POLL_MS) };
  } else g[KEY].handler = poll;
}
