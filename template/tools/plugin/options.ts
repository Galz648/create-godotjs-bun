// The plugin's per-rewrite switches (ADR 0009). One boolean per source rewrite, all on by default.
// Validation (warnings, scene checks, build errors) is not a rewrite and has no switch, with these exceptions, each a check
// that can be turned off for code that must build anyway: `abortGuards` (build errors for calls that kill the engine),
// `badConversions` (build errors for constructors that return garbage), `lostWrites`, `valueStrings` and `packedIteration` (warnings),
// `effectBarrel`, `leakCalls` and `inputVirtuals` (warnings, leak-checks.ts; one file opts out with `// godotjs-plugin-allow: <names>`).
// Where a project sets them (later lines override earlier ones):
//   1. package.json  "godotjs": { "plugin": { "connect": false } }   (the project's standing choice)
//   2. env GODOTJS_NO_STORED=1                     (older test hook, same as GODOTJS_PLUGIN_OFF=stored)
//   3. env GODOTJS_PLUGIN_OFF=exports,connect      (comma list of switches to turn OFF; "all" turns every one off)
// A switch that is off leaves its construct as written; see docs/PLUGIN-REWRITES.md for the explicit form of each.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PluginRewrites {
  /** `@gd.export()` typed from the TS type, plus `export.array(...)` / `export.object(...)` helpers. */
  exports: boolean;
  /** `@gd.onready("Path")` stripped and assigned in a generated `_ready`. */
  onready: boolean;
  /** `@gd.class` added to a script class, `@gd.signal()` added to a Signal-typed accessor. */
  register: boolean;
  /** `@gd.stored("<Class>.<field>")` added to plain instance accessors. */
  stored: boolean;
  /** `connect(fn)` and friends: a function argument wrapped in `Callable.create(...)`. */
  connect: boolean;
  /** Build errors for engine-aborting calls (tickets 80 to 85, abort-checks.ts). A check, not a source rewrite: nothing is edited, only reported. */
  abortGuards: boolean;
  /** Build errors for conversion constructors that return garbage without an error (ticket 262, value-checks.ts). */
  badConversions: boolean;
  /** Warning for a write to a member of a value type the engine copied out: `node.rotation.y = x` (ticket 265, value-checks.ts). */
  lostWrites: boolean;
  /** Warning for a builtin value type in a template literal, `String()`, `'' + v` or `JSON.stringify` (ticket 267, value-checks.ts). */
  valueStrings: boolean;
  /** Warning for for...of, spread or `Array.from` of a Packed*Array (ticket 268, value-checks.ts). */
  packedIteration: boolean;
  /** Warning for `import ... from "effect"`, the barrel (ticket 441, leak-checks.ts). */
  effectBarrel: boolean;
  /** Warning for `create_timer`, `create_tween`, `get_slide_collision`, `get_last_slide_collision` (the leak family; ticket 441). */
  leakCalls: boolean;
  /** Warning for an `_input` / `_unhandled_input` method on a class that extends a Godot class (the leak family; ticket 441). */
  inputVirtuals: boolean;
}

export const REWRITE_NAMES = ["exports", "onready", "register", "stored", "connect", "abortGuards", "badConversions", "lostWrites", "valueStrings", "packedIteration", "effectBarrel", "leakCalls", "inputVirtuals"] as const satisfies readonly (keyof PluginRewrites)[];

export const DEFAULT_REWRITES: Readonly<PluginRewrites> = { exports: true, onready: true, register: true, stored: true, connect: true, abortGuards: true, badConversions: true, lostWrites: true, valueStrings: true, packedIteration: true, effectBarrel: true, leakCalls: true, inputVirtuals: true };

/** Defaults with `partial` applied. */
export function withRewrites(partial: Partial<PluginRewrites> = {}): PluginRewrites {
  return { ...DEFAULT_REWRITES, ...partial };
}

/** Read the switches for a project. Throws on a name that is not a switch, so a typo cannot silently do nothing. */
export function resolveRewrites(root: string, env: Record<string, string | undefined> = process.env): PluginRewrites {
  const out: PluginRewrites = { ...DEFAULT_REWRITES };
  const known = (name: string): name is keyof PluginRewrites => (REWRITE_NAMES as readonly string[]).includes(name);

  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    let cfg: unknown;
    try {
      cfg = (JSON.parse(readFileSync(pkg, "utf8")) as { godotjs?: { plugin?: unknown } }).godotjs?.plugin;
    } catch {
      cfg = undefined; // a broken package.json is bun's error to report, not ours
    }
    if (cfg && typeof cfg === "object") {
      for (const [name, value] of Object.entries(cfg)) {
        if (!known(name)) throw new Error(`package.json godotjs.plugin.${name}: not a plugin switch (${REWRITE_NAMES.join(", ")})`);
        if (typeof value !== "boolean") throw new Error(`package.json godotjs.plugin.${name} must be true or false`);
        out[name] = value;
      }
    }
  }

  if (env.GODOTJS_NO_STORED === "1") out.stored = false;
  const off = (env.GODOTJS_PLUGIN_OFF ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const name of off) {
    if (name === "all") {
      for (const n of REWRITE_NAMES) out[n] = false;
    } else if (known(name)) out[name] = false;
    else throw new Error(`GODOTJS_PLUGIN_OFF: "${name}" is not a plugin switch (${REWRITE_NAMES.join(", ")}, all)`);
  }
  return out;
}
