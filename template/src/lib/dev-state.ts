// Keep game state across `bun run dev` relaunches. Dev-only: with GODOTJS_DEV_STATE unset (exports, `bun run
// start`, `bun run headless`, the editor) devState() does nothing: no timer, no file access, no output.
//
//   devState("sim", { save: () => sim.store.state, load: (s) => { sim.store.state = s; } });
//
// Call it once the thing it saves exists (usually in _ready). If the previous dev process saved a state for
// "sim" that still fits, load() runs right now, synchronously, and devState returns true. Design and rejected
// alternatives: docs/design/dev-state.md.

export type DevStateOptions<T> = {
  /** The state as plain JSON data (numbers, strings, booleans, null, arrays, plain objects). */
  save: () => T;
  /** Receives a state saved by an earlier process. May throw: the saved state is then discarded. */
  load: (state: T) => void;
  /** Bump when the meaning of the data changes in a way its shape does not show. A different version discards. */
  version?: number;
  /** Compare the saved data's shape (keys and value types) with what save() returns now. Default true. */
  shape?: boolean;
};

import { fits, shapeOf, type Shape } from "./shape";

type Entry = { version: number; shape: Shape; data: unknown };
type Registration = { version: number; checkShape: boolean; save: () => unknown; load: (state: any) => void };

const POLL_MS = 100;
const READ = 1;
const WRITE = 2;

// The shim typings and the generated typings declare different things, so reach the two engine classes untyped.
// require() rather than `import * as`: the engine's module object has no __esModule, which the import helper reads.
const engine = require("godot") as {
  OS: { get_environment(name: string): string };
  FileAccess: {
    file_exists(path: string): boolean;
    open(path: string, flags: number): { get_as_text(): string; store_string(text: string): boolean; close(): void } | null;
  };
};

const dir = readDir();

// One registry per process, not per copy of this file: every script bundle inlines its own copy of the library, and
// copies that each kept their own map and timer overwrote each other's state.json (docs/design/devstate-two-bundles.md).
// The registry's field set is a contract between copies, so the Symbol key carries a layout tag: a copy with a
// different layout (a toolchain update in one bundle only, which one build cannot produce) gets its own registry
// instead of reading fields that are not there. Change the tag when you change Registry.
type Registry = {
  registered: Map<string, Registration>;
  saved: Map<string, Entry> | undefined; // what the previous process left, read once, entries consumed on use
  lastToken: string;
  timer: ReturnType<typeof setInterval> | undefined;
};
const REGISTRY_KEY = Symbol.for("godotjs.dev-state.v1");
const g = globalThis as unknown as Record<symbol, Registry | undefined>;
const reg0: Registry = (g[REGISTRY_KEY] ??= { registered: new Map(), saved: undefined, lastToken: "", timer: undefined });
const registered = reg0.registered;

function readDir(): string {
  try {
    return String(engine.OS.get_environment("GODOTJS_DEV_STATE") ?? "").trim();
  } catch {
    return "";
  }
}

function say(message: string): void {
  console.log(`dev-state: ${message}`);
}

function readText(path: string): string | undefined {
  if (!engine.FileAccess.file_exists(path)) return undefined;
  const file = engine.FileAccess.open(path, READ);
  if (!file) return undefined;
  const text = file.get_as_text();
  file.close();
  return text;
}

function writeText(path: string, text: string): boolean {
  const file = engine.FileAccess.open(path, WRITE);
  if (!file) return false;
  file.store_string(text);
  file.close();
  return true;
}

function loadSaved(): Map<string, Entry> {
  if (reg0.saved) return reg0.saved;
  const saved = (reg0.saved = new Map<string, Entry>());
  const text = readText(`${dir}/state.json`);
  if (text === undefined) return saved;
  try {
    const parsed = JSON.parse(text) as { entries?: Record<string, Entry> };
    for (const [name, entry] of Object.entries(parsed.entries ?? {})) saved.set(name, entry);
  } catch {
    say("saved state is unreadable; starting fresh");
  }
  return saved;
}

function snapshot(token: string): string {
  const entries: Record<string, Entry> = {};
  for (const [name, reg] of registered) {
    try {
      const data = reg.save();
      const text = JSON.stringify(data);
      if (text === undefined) throw new Error("save() returned nothing JSON can hold");
      entries[name] = { version: reg.version, shape: shapeOf(JSON.parse(text)), data: JSON.parse(text) };
    } catch (err) {
      say(`could not save "${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return JSON.stringify({ token, entries });
}

// The runner writes <dir>/request containing a token. Answer by writing <dir>/state.json carrying the same token.
function poll(): void {
  const token = (readText(`${dir}/request`) ?? "").trim();
  if (token === "" || token === reg0.lastToken) return;
  reg0.lastToken = token;
  if (!writeText(`${dir}/state.json`, snapshot(token))) say("could not write the state file");
}

/**
 * Register state to keep across dev relaunches. Returns true when a saved state was restored.
 * Registering the same name again replaces the earlier registration (a restored state is only used once).
 */
export function devState<T>(name: string, options: DevStateOptions<T>): boolean {
  if (dir === "") return false;
  const reg: Registration = {
    version: options.version ?? 1,
    checkShape: options.shape !== false,
    save: options.save,
    load: options.load,
  };
  registered.set(name, reg);
  if (reg0.timer === undefined) reg0.timer = setInterval(poll, POLL_MS);

  const entry = loadSaved().get(name);
  if (!entry) return false;
  reg0.saved?.delete(name);
  if (entry.version !== reg.version) {
    say(`discarded "${name}": saved by version ${String(entry.version)}, now version ${reg.version}`);
    return false;
  }
  if (reg.checkShape) {
    let now: Shape = null;
    try {
      now = shapeOf(JSON.parse(JSON.stringify(reg.save())));
    } catch {
      // a save() that throws here is reported when a snapshot is taken
    }
    if (!fits(entry.shape, now)) {
      say(`discarded "${name}": its shape changed since it was saved`);
      return false;
    }
  }
  try {
    reg.load(entry.data);
  } catch (err) {
    say(`discarded "${name}": load() threw ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  say(`restored "${name}"`);
  return true;
}
