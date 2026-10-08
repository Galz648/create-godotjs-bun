// Game services kit: everything in one import, and the two combined Layers. OPT-IN, Effect projects only (not in
// tools/toolchain-files.json, removed by create-godotjs-bun --no-effect). Imports Effect by subpath.
//
//   import { GameServicesLive, Settings, Input, makeInputBridge } from "./lib/services";
//   const input = makeInputBridge(["jump", "fire"]);                 // in one node's _ready: onInputEvent(this, (ev) => input.handle(ev))
//                                                                    // (src/lib/leak-free.ts; an _input method leaks one engine object per event)
//   const layer = GameServicesLive({ input, audio: { parent: this, sounds: { click: "res://click.wav" } }, seed: 42 });
//   Effect.runFork(game.pipe(Effect.provide(layer)));                  // needs a Scope for the audio pool: Layer.build in a nodeScope
//
//   import { GameServicesTest } from "./lib/services";               // tests: no engine, every service in memory
//   const t = GameServicesTest({ seed: 1, files: { "res://a.png": 1 } });
//   program.pipe(Effect.provide(t.layer));  t.input.press("jump");  t.audio.calls;  t.loader.calls;
//
// Services are independent: provide only the Layers a program needs (`Settings.layer()`, `Random.layer(7)`, ...).
import * as Layer from "effect/Layer";
import { Assets, fakeLoader, type FakeLoader } from "./assets";
import { Audio, recordingBackend, type AudioLayerOptions, type RecordingBackend } from "./audio";
import { GodotConfig, type GodotConfigSource } from "./godot-config";
import { Input, makeInputBridge, type InputBridge } from "./input";
import { Random } from "./random";
import { memoryBackend, Settings, type MemoryBackend } from "./settings";

export * from "./assets";
export * from "./audio";
export * from "./godot-config";
export * from "./input";
export * from "./random";
export * from "./settings";

export interface GameServicesOptions {
  /** The bridge a node feeds through `onInputEvent(node, (ev) => bridge.handle(ev))` (see makeInputBridge). */
  readonly input: InputBridge;
  readonly audio: AudioLayerOptions;
  /** Seed of the game's Random (a number or a string). */
  readonly seed: number | string;
  /** Default `user://settings.cfg`. */
  readonly settingsPath?: string;
  /** Default 16 ms. */
  readonly assetPollMs?: number;
  readonly configSource?: GodotConfigSource;
}

/** The live Layers: ConfigFile settings, the input bridge, ResourceLoader assets, the player pool, the seeded Random and the Godot ConfigProvider. */
export const GameServicesLive = (o: GameServicesOptions) =>
  Layer.mergeAll(
    Settings.layer({ path: o.settingsPath }),
    Input.layer(o.input),
    Assets.layer({ pollMs: o.assetPollMs }),
    Audio.layer(o.audio),
    Random.layer(o.seed),
    GodotConfig.layer(o.configSource),
  );

export interface GameServicesTestOptions {
  readonly seed?: number | string;
  /** Resource paths the fake loader knows (path to value). */
  readonly files?: Record<string, unknown>;
  readonly sounds?: Record<string, unknown>;
  readonly actions?: readonly string[];
  readonly args?: readonly string[];
  readonly settings?: Record<string, unknown>;
}

/** The test Layers, plus the handles a test drives and inspects (no engine needed). */
export const GameServicesTest = (o: GameServicesTestOptions = {}) => {
  const input = makeInputBridge(o.actions ?? []);
  const loader: FakeLoader = fakeLoader(o.files ?? {});
  const audio: RecordingBackend = recordingBackend();
  const settings: MemoryBackend = memoryBackend();
  const layer = Layer.mergeAll(
    Settings.testLayer(settings),
    Input.testLayer(input),
    Assets.testLayer(loader),
    Audio.testLayer(o.sounds ?? {}, audio),
    Random.testLayer(o.seed ?? 1),
    GodotConfig.testLayer({ args: o.args, settings: o.settings }),
  );
  return { layer, input, loader, audio, settings };
};
