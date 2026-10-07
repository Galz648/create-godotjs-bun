// Game services kit: Audio, a small AudioStreamPlayer pool, `play(name)` and bus volume. OPT-IN, Effect projects only (not in
// tools/toolchain-files.json, removed by create-godotjs-bun --no-effect). Imports Effect by subpath.
// Tested by starter/tests/effect-services (logic.test.ts with the recording backend, the engine scene with real players).
//
//   const layer = Audio.layer({ parent: this, sounds: { click: "res://sfx/click.wav", hit: hitStream }, poolSize: 8 });
//   yield* (yield* Audio).play("click");                           // fire and forget; fails with UnknownSound for a typo
//   yield* audio.play("hit", { volume: 0.5, pitch: 1.2 });          // volume is LINEAR 0..4 (1 = unchanged)
//   yield* audio.setBusVolume("Music", 0.3);                        // linear, mapped to dB
//
// Rules this encodes:
//  1. A fixed pool: sounds never create nodes while playing. Playing takes an idle player; when all are busy it STEALS the one
//     that started first (round robin by start order) and counts it in `stats.stolen`. A sound is never refused for being busy.
//  2. The pool is a Layer resource: players are children of `parent`, created when the Layer is built and stopped and freed
//     when its scope closes (build the Layer in a scope tied to the node, e.g. godot-effect.ts `nodeScope`). 0 nodes remain.
//  3. Volume is linear in the API and dB in the engine (20 * log10; 0 maps to -80 dB, which is silent). A bus that does not
//     exist fails with `UnknownBus` instead of writing to bus index -1.
//  4. A sound given as a path string is loaded on first play with the ResourceLoader (and cached); a missing file fails with
//     `SoundLoadFailed` and the engine prints nothing (the path is checked with ResourceLoader.exists first).
//  5. Headless runs use the dummy audio driver: `play` works, nothing is heard, and `playing` follows the stream length.
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { godot, type NodeLike, type PlayerLike } from "./engine";

export class UnknownSound extends Data.TaggedError("UnknownSound")<{ readonly name: string }> {}
export class UnknownBus extends Data.TaggedError("UnknownBus")<{ readonly bus: string }> {}
export class SoundLoadFailed extends Data.TaggedError("SoundLoadFailed")<{ readonly name: string; readonly path: string }> {}

export interface PlayOptions {
  /** Linear gain, 0..4, default 1. */
  readonly volume?: number;
  readonly pitch?: number;
  /** Default: the Layer's bus ("Master"). */
  readonly bus?: string;
}

export interface AudioStats { readonly played: number; readonly stolen: number }

export interface AudioShape {
  readonly play: (name: string, options?: PlayOptions) => Effect.Effect<void, UnknownSound | UnknownBus | SoundLoadFailed>;
  readonly stopAll: Effect.Effect<void>;
  readonly setBusVolume: (bus: string, linear: number) => Effect.Effect<void, UnknownBus>;
  readonly busVolume: (bus: string) => Effect.Effect<number, UnknownBus>;
  /** Players playing right now. */
  readonly active: Effect.Effect<number>;
  readonly stats: Effect.Effect<AudioStats>;
}

/** The engine side of the pool. The live backend wraps AudioStreamPlayer nodes and AudioServer; tests use `recordingBackend`. */
export interface AudioBackend {
  readonly size: number;
  isPlaying(i: number): boolean;
  start(i: number, stream: unknown, bus: string, volumeDb: number, pitch: number): void;
  stop(i: number): void;
  /** undefined when the bus does not exist. */
  busVolumeDb(bus: string): number | undefined;
  setBusVolumeDb(bus: string, db: number): boolean;
  /** Turn a path into a stream; null when it does not exist or does not load. */
  loadStream(path: string): unknown;
}

export const linearToDb = (v: number): number => (v <= 0 ? -80 : Math.max(-80, 20 * Math.log10(v)));
export const dbToLinear = (db: number): number => (db <= -80 ? 0 : 10 ** (db / 20));
const clampLinear = (v: number) => Math.min(4, Math.max(0, v));

export const makeAudio = (backend: AudioBackend, sounds: Record<string, unknown>, options: { readonly bus?: string } = {}): AudioShape => {
  const defaultBus = options.bus ?? "Master";
  const resolved = new Map<string, unknown>();
  const startedAt: number[] = Array.from({ length: backend.size }, () => -1);
  let tick = 0;
  let played = 0;
  let stolen = 0;

  const streamOf = (name: string): Effect.Effect<unknown, UnknownSound | SoundLoadFailed> =>
    Effect.suspend((): Effect.Effect<unknown, UnknownSound | SoundLoadFailed> => {
      if (resolved.has(name)) return Effect.succeed(resolved.get(name));
      if (!Object.hasOwn(sounds, name)) return Effect.fail(new UnknownSound({ name }));
      const src = sounds[name];
      if (typeof src !== "string") return Effect.sync(() => (resolved.set(name, src), src));
      const stream = backend.loadStream(src);
      if (stream === null || stream === undefined) return Effect.fail(new SoundLoadFailed({ name, path: src }));
      return Effect.sync(() => (resolved.set(name, stream), stream));
    });

  /** Idle player first; otherwise the one that started first (rule 1). */
  const pick = (): number => {
    for (let i = 0; i < backend.size; i++) if (!backend.isPlaying(i)) return i;
    let oldest = 0;
    for (let i = 1; i < backend.size; i++) if (startedAt[i]! < startedAt[oldest]!) oldest = i;
    stolen++;
    return oldest;
  };

  return {
    play: (name, o = {}) =>
      Effect.gen(function* () {
        const stream = yield* streamOf(name);
        const bus = o.bus ?? defaultBus;
        if (backend.busVolumeDb(bus) === undefined) return yield* Effect.fail(new UnknownBus({ bus }));
        yield* Effect.sync(() => {
          const i = pick();
          backend.start(i, stream, bus, linearToDb(clampLinear(o.volume ?? 1)), o.pitch ?? 1);
          startedAt[i] = tick++;
          played++;
        });
      }),
    stopAll: Effect.sync(() => {
      for (let i = 0; i < backend.size; i++) backend.stop(i);
    }),
    setBusVolume: (bus, linear) =>
      Effect.suspend(() => (backend.setBusVolumeDb(bus, linearToDb(clampLinear(linear))) ? Effect.void : Effect.fail(new UnknownBus({ bus })))),
    busVolume: (bus) =>
      Effect.suspend(() => {
        const db = backend.busVolumeDb(bus);
        return db === undefined ? Effect.fail(new UnknownBus({ bus })) : Effect.succeed(dbToLinear(db));
      }),
    active: Effect.sync(() => {
      let n = 0;
      for (let i = 0; i < backend.size; i++) if (backend.isPlaying(i)) n++;
      return n;
    }),
    stats: Effect.sync(() => ({ played, stolen })),
  };
};

/** Live pool: `size` AudioStreamPlayer children of `parent`, freed with the scope. */
export const playerPoolBackend = (parent: NodeLike, size: number, engine: ReturnType<typeof godot> = godot()): Effect.Effect<AudioBackend, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const players: PlayerLike[] = [];
      for (let i = 0; i < size; i++) {
        const p = new engine.AudioStreamPlayer();
        p.set_name(`GamePlayer${i}`);
        parent.add_child(p);
        players.push(p);
      }
      return players;
    }),
    (players) =>
      Effect.sync(() => {
        for (const p of players) if (engine.is_instance_valid(p)) { p.stop(); p.queue_free(); }
      }),
  ).pipe(
    Effect.map((players): AudioBackend => ({
      size,
      isPlaying: (i) => players[i]!.playing,
      start: (i, stream, bus, db, pitch) => {
        const p = players[i]!;
        p.stream = stream;
        p.bus = bus;
        p.volume_db = db;
        p.pitch_scale = pitch;
        p.play();
      },
      stop: (i) => players[i]!.stop(),
      busVolumeDb: (bus) => {
        const idx = engine.AudioServer.get_bus_index(bus);
        return idx < 0 ? undefined : engine.AudioServer.get_bus_volume_db(idx);
      },
      setBusVolumeDb: (bus, db) => {
        const idx = engine.AudioServer.get_bus_index(bus);
        if (idx < 0) return false;
        engine.AudioServer.set_bus_volume_db(idx, db);
        return true;
      },
      loadStream: (path) => (engine.ResourceLoader.exists(path) ? engine.ResourceLoader.load(path) : null),
    })),
  );

export interface RecordedCall { readonly op: "start" | "stop"; readonly player: number; readonly stream?: unknown; readonly bus?: string; readonly volumeDb?: number; readonly pitch?: number }
export interface RecordingBackend extends AudioBackend {
  readonly calls: RecordedCall[];
  readonly buses: Map<string, number>;
  /** Simulate a player reaching the end of its sound. */
  finish(i: number): void;
}
/** No engine: records every call. Players keep playing until the test calls `finish(i)` or `stop`. */
export const recordingBackend = (size = 4, buses: Record<string, number> = { Master: 0 }): RecordingBackend => {
  const playing: boolean[] = Array.from({ length: size }, () => false);
  const calls: RecordedCall[] = [];
  const busMap = new Map(Object.entries(buses));
  return {
    size,
    calls,
    buses: busMap,
    isPlaying: (i) => playing[i]!,
    start: (i, stream, bus, volumeDb, pitch) => {
      playing[i] = true;
      calls.push({ op: "start", player: i, stream, bus, volumeDb, pitch });
    },
    stop: (i) => {
      if (playing[i]) calls.push({ op: "stop", player: i });
      playing[i] = false;
    },
    busVolumeDb: (bus) => busMap.get(bus),
    setBusVolumeDb: (bus, db) => (busMap.has(bus) ? (busMap.set(bus, db), true) : false),
    loadStream: (path) => (path.includes("missing") ? null : `stream:${path}`),
    finish: (i) => void (playing[i] = false),
  };
};

export interface AudioLayerOptions {
  readonly parent: NodeLike;
  readonly sounds: Record<string, unknown>;
  readonly poolSize?: number;
  readonly bus?: string;
}

export class Audio extends Context.Service<Audio, AudioShape>()("game.Audio") {
  /** Live: a pool of `poolSize` (default 8) AudioStreamPlayers under `parent`, released with the Layer's scope. */
  static layer = (o: AudioLayerOptions): Layer.Layer<Audio> =>
    Layer.effect(
      Audio,
      Effect.map(playerPoolBackend(o.parent, o.poolSize ?? 8), (backend) => makeAudio(backend, o.sounds, { bus: o.bus })),
    );
  /** Test: any backend (default: a recording one the test inspects; build it with `recordingBackend()` to keep a handle). */
  static testLayer = (sounds: Record<string, unknown> = {}, backend: AudioBackend = recordingBackend(), options: { readonly bus?: string } = {}): Layer.Layer<Audio> =>
    Layer.sync(Audio, () => makeAudio(backend, sounds, options));
}
