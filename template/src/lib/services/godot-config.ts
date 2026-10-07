// Game services kit: an Effect ConfigProvider over the command line and ProjectSettings. OPT-IN, Effect projects only (not in
// tools/toolchain-files.json, removed by create-godotjs-bun --no-effect). Imports Effect by subpath.
// Tested by starter/tests/effect-services (logic.test.ts with a fake source, the engine scene with a real command line).
//
//   godot --path . -- --debug.overlay=true --level=3        (everything after `--` is a user argument)
//   const overlay = yield* Config.Boolean("debug.overlay").pipe(Config.withDefault(false));   // Effect 4 names: Config.String, Config.Boolean, Config.Int
//   program.pipe(Effect.provide(GodotConfig.layer()))
//
// Rules this encodes:
//  1. A config path joins with "." for the command line (`--debug.overlay=true`) and with "/" for ProjectSettings (a path
//     ["application","config","name"] reads the setting `application/config/name`; a one-segment name works in both).
//  2. The command line wins over ProjectSettings, so a debug flag can override a default from project.godot. Only USER arguments
//     (after `--`) are read, never the engine's own flags. Forms: `--key=value` and a bare `--key` (the value "true").
//  3. `OS.get_cmdline_user_args()` is a PackedStringArray, which is not iterable from JS: the source reads it with size() and get(i).
//  4. ProjectSettings values that are strings, numbers or booleans become their text; anything else (Vector2, Dictionary, ...) reads
//     as "missing", so Config.withDefault applies instead of a surprise "[object Object]".
//  5. Add your own settings under a custom section in project.godot (`[game]` then `debug/overlay=true`), they are plain ProjectSettings.
//  6. Empty strings count as missing (Effect's default), so `--name=` falls back to the default.
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { godot, toStrings } from "./engine";

/** Where the values come from. The live source is OS + ProjectSettings; tests pass plain data. */
export interface GodotConfigSource {
  /** The user arguments (after `--`), already as strings. */
  args(): readonly string[];
  /** The value of a ProjectSettings key, or undefined when it is not set. */
  setting(key: string): unknown;
}

export const liveSource = (engine: ReturnType<typeof godot> = godot()): GodotConfigSource => ({
  args: () => toStrings(engine.OS.get_cmdline_user_args()),
  setting: (key) => (engine.ProjectSettings.has_setting(key) ? engine.ProjectSettings.get_setting(key) : undefined),
});

/** Parse `--key=value` and bare `--key` arguments; the last one wins, anything else is ignored. */
export const parseUserArgs = (args: readonly string[]): Map<string, string> => {
  const out = new Map<string, string>();
  for (const a of args) {
    if (!a.startsWith("--") || a.length === 2) continue;
    const eq = a.indexOf("=");
    if (eq < 0) out.set(a.slice(2), "true");
    else if (eq > 2) out.set(a.slice(2, eq), a.slice(eq + 1));
  }
  return out;
};

const text = (v: unknown): string | undefined => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : undefined);

export const makeGodotConfigProvider = (source: GodotConfigSource = liveSource()): ConfigProvider.ConfigProvider =>
  ConfigProvider.make((path) =>
    Effect.sync(() => {
      if (path.length === 0) return undefined;
      const args = parseUserArgs(source.args());
      const fromArgs = args.get(path.join("."));
      if (fromArgs !== undefined) return fromArgs === "" ? undefined : ConfigProvider.makeValue(fromArgs);
      const fromSettings = text(source.setting(path.join("/")));
      return fromSettings === undefined || fromSettings === "" ? undefined : ConfigProvider.makeValue(fromSettings);
    }),
  );

export const GodotConfig = {
  /** Replace the active ConfigProvider with the command line + ProjectSettings one. */
  layer: (source?: GodotConfigSource): Layer.Layer<never> => ConfigProvider.layer(makeGodotConfigProvider(source)),
  /** Test: the same provider over plain data, no engine. */
  testLayer: (source: { readonly args?: readonly string[]; readonly settings?: Record<string, unknown> } = {}): Layer.Layer<never> =>
    ConfigProvider.layer(makeGodotConfigProvider({ args: () => source.args ?? [], setting: (k) => source.settings?.[k] })),
};
