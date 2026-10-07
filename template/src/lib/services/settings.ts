// Game services kit: Settings, a typed key-value store backed by Godot's ConfigFile in `user://`. OPT-IN, Effect projects
// only (not in tools/toolchain-files.json, removed by create-godotjs-bun --no-effect). Imports Effect by subpath.
// Tested by starter/tests/effect-services (logic.test.ts with the in-memory Layer, the engine scene with the live one).
//
//   const s = yield* Settings;
//   const vol = yield* s.get("audio", "music_volume", Schema.Number, 0.8);   // never fails: missing or invalid -> the default
//   yield* s.set("audio", "music_volume", Schema.Number, 0.3);               // fails only if the value does not encode
//   yield* s.save;                                                           // atomic: write `<path>.tmp`, then rename over the file
//   yield* s.watch("audio", "music_volume", Schema.Number, 0.8).pipe(Stream.runForEach(applyVolume));   // current value, then changes
//
// Rules this encodes:
//  1. A broken setting must never stop the game: `get` falls back to the default for a missing key AND for a stored value
//     that no longer decodes (a schema change, a hand-edited file). Only IO (`save`) and encoding (`set`) are typed errors.
//  2. Values are stored as JSON text of `Schema.toCodecJson` (one rule for every type: Option, Map, BigInt, unions). The file
//     reads `volume="0.3"`. This avoids Godot's int-versus-float guess and the NUL / surrogate string losses (see DAILY.md,
//     "Crossing the Godot boundary").
//  3. `set` with the value already stored changes nothing and emits nothing, so a UI that writes back what it just read does not loop.
//  4. Saving is atomic (temp file, then DirAccess.rename_absolute replaces the target): a crash mid-save leaves the old file.
//     Saving is synchronous with no yield point, so concurrent saves cannot interleave. Call `save` when the player leaves the
//     settings screen, not on every slider tick.
//  5. A missing file is the normal first run (`loadCode` 7); an unreadable one starts empty (`loadCode` is the engine code, and
//     the engine prints its parse error). The broken file is replaced by the next save.
//  6. `changes` is a PubSub stream: it sees changes made AFTER it is subscribed (use `watch` to get the current value first).
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";
import { godot } from "./engine";

/** `set`: the value does not encode with the schema (nothing was stored). */
export class SettingsInvalid extends Data.TaggedError("SettingsInvalid")<{ readonly section: string; readonly key: string; readonly issue: SchemaIssue.Issue }> {
  override get message() { return `${this.section}/${this.key}: ${SchemaIssue.makeFormatterDefault()(this.issue)}`; }
}
/** `save`: the temp file could not be written (`step: "write"`) or renamed over the target (`"rename"`); `code` is the engine Error. */
export class SettingsIOError extends Data.TaggedError("SettingsIOError")<{ readonly path: string; readonly step: "write" | "rename"; readonly code: number }> {}

/** One change: `raw` is the stored JSON text, undefined when the key was removed. */
export interface SettingChange { readonly section: string; readonly key: string; readonly raw: string | undefined }

/** Where raw JSON text lives. The live backend is a ConfigFile; the test backend is a Map. */
export interface SettingsBackend {
  /** 0 = loaded, 7 = no file yet, anything else = unreadable and started empty. */
  readonly loadCode: number;
  get(section: string, key: string): string | undefined;
  set(section: string, key: string, raw: string): void;
  remove(section: string, key: string): boolean;
  /** undefined = saved. */
  save(): { step: "write" | "rename"; code: number } | undefined;
}

export interface SettingsShape {
  readonly loadCode: number;
  readonly get: <S extends Schema.Top>(section: string, key: string, schema: S, defaultValue: S["Type"]) => Effect.Effect<S["Type"]>;
  readonly set: <S extends Schema.Top>(section: string, key: string, schema: S, value: S["Type"]) => Effect.Effect<void, SettingsInvalid>;
  readonly remove: (section: string, key: string) => Effect.Effect<void>;
  readonly save: Effect.Effect<void, SettingsIOError>;
  /** True when something changed since the last successful save. */
  readonly dirty: Effect.Effect<boolean>;
  readonly changes: Stream.Stream<SettingChange>;
  /** The current value, then every change of this key, decoded (an invalid or removed value comes as the default). */
  readonly watch: <S extends Schema.Top>(section: string, key: string, schema: S, defaultValue: S["Type"]) => Stream.Stream<S["Type"]>;
}

const codecOf = (schema: Schema.Top) => Schema.toCodecJson(schema) as unknown as Schema.Codec<any, unknown>;

export const makeSettings = (backend: SettingsBackend, path = "(memory)"): Effect.Effect<SettingsShape> =>
  Effect.gen(function* () {
    const bus = yield* PubSub.unbounded<SettingChange>();
    let dirty = false;

    const decode = <S extends Schema.Top>(raw: string | undefined, schema: S, def: S["Type"]): Effect.Effect<S["Type"]> => {
      if (raw === undefined) return Effect.succeed(def);
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return Effect.succeed(def);
      }
      return Schema.decodeUnknownEffect(codecOf(schema))(json).pipe(Effect.orElseSucceed(() => def));
    };

    const get: SettingsShape["get"] = (section, key, schema, def) => Effect.suspend(() => decode(backend.get(section, key), schema, def));

    const set: SettingsShape["set"] = (section, key, schema, value) =>
      Schema.encodeEffect(codecOf(schema))(value).pipe(
        Effect.mapError((e: { issue: SchemaIssue.Issue }) => new SettingsInvalid({ section, key, issue: e.issue })),
        Effect.flatMap((json) =>
          Effect.sync(() => {
            const raw = JSON.stringify(json);
            if (backend.get(section, key) === raw) return;
            backend.set(section, key, raw);
            dirty = true;
            PubSub.publishUnsafe(bus, { section, key, raw });
          }),
        ),
      );

    const remove: SettingsShape["remove"] = (section, key) =>
      Effect.sync(() => {
        if (backend.remove(section, key)) {
          dirty = true;
          PubSub.publishUnsafe(bus, { section, key, raw: undefined });
        }
      });

    const save: SettingsShape["save"] = Effect.suspend(() => {
      const failed = backend.save();
      if (failed) return Effect.fail(new SettingsIOError({ path, ...failed }));
      dirty = false;
      return Effect.void;
    });

    const changes = Stream.fromPubSub(bus);
    const watch: SettingsShape["watch"] = (section, key, schema, def) =>
      Stream.concat(
        Stream.fromEffect(get(section, key, schema, def)),
        changes.pipe(
          Stream.filter((c) => c.section === section && c.key === key),
          Stream.mapEffect((c) => decode(c.raw, schema, def)),
        ),
      );

    return { loadCode: backend.loadCode, get, set, remove, save, dirty: Effect.sync(() => dirty), changes, watch } satisfies SettingsShape;
  });

/** In-memory backend: what the test Layer uses. `saved` holds a snapshot per successful save; `failSave` makes the next saves fail. */
export interface MemoryBackend extends SettingsBackend {
  readonly data: Map<string, string>;
  readonly saved: Array<Record<string, string>>;
  failSave: { step: "write" | "rename"; code: number } | undefined;
}
export const memoryBackend = (initial: Record<string, string> = {}): MemoryBackend => {
  const data = new Map(Object.entries(initial)); // keys are "section\u0000key"
  const k = (s: string, key: string) => `${s}\u0000${key}`;
  const b: MemoryBackend = {
    loadCode: 0,
    data,
    saved: [],
    failSave: undefined,
    get: (s, key) => data.get(k(s, key)),
    set: (s, key, raw) => void data.set(k(s, key), raw),
    remove: (s, key) => data.delete(k(s, key)),
    save: () => {
      if (b.failSave) return b.failSave;
      b.saved.push(Object.fromEntries(data));
      return undefined;
    },
  };
  return b;
};

/** ConfigFile backend over `user://...cfg` with an atomic save. `engine` is a seam for tests (default: the real `godot` module). */
export const configFileBackend = (path: string, engine: ReturnType<typeof godot> = godot()): SettingsBackend => {
  const cf = new engine.ConfigFile();
  const tmp = `${path}.tmp`;
  const loadCode = engine.FileAccess.file_exists(path) ? cf.load(path) : 7; // never load() a missing file: prefer the exists check
  return {
    loadCode,
    get: (s, key) => (cf.has_section_key(s, key) ? String(cf.get_value(s, key)) : undefined),
    set: (s, key, raw) => cf.set_value(s, key, raw),
    remove: (s, key) => {
      const had = cf.has_section_key(s, key);
      if (had) cf.erase_section_key(s, key);
      return had;
    },
    save: () => {
      const w = cf.save(tmp);
      if (w !== 0) {
        engine.DirAccess.remove_absolute(tmp);
        return { step: "write", code: w };
      }
      const r = engine.DirAccess.rename_absolute(tmp, path);
      if (r !== 0) {
        engine.DirAccess.remove_absolute(tmp);
        return { step: "rename", code: r };
      }
      return undefined;
    },
  };
};

export class Settings extends Context.Service<Settings, SettingsShape>()("game.Settings") {
  /** Live: a ConfigFile at `path` (default `user://settings.cfg`), loaded now. */
  static layer = (options: { readonly path?: string } = {}): Layer.Layer<Settings> => {
    const path = options.path ?? "user://settings.cfg";
    return Layer.effect(Settings, Effect.suspend(() => makeSettings(configFileBackend(path), path)));
  };
  /** Test: in memory, nothing touches the engine. `initial` keys are "section\u0000key" -> JSON text. */
  static testLayer = (backend: SettingsBackend = memoryBackend()): Layer.Layer<Settings> => Layer.effect(Settings, makeSettings(backend));
}
