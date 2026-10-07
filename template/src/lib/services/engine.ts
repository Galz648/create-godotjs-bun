// Game services kit, internal: the slice of the `godot` module the live Layers use, typed locally and required lazily
// (like game-clock.ts and hot-reload.ts), so the kit typechecks with the shim and the generated typings alike and the
// pure parts and the test Layers import fine under plain `bun test` (where there is no `godot` module).
// Opt-in, Effect projects only: removed with the rest of src/lib/services by create-godotjs-bun --no-effect.

export interface GArrayLike { size(): number; get(i: number): any }
export interface ConfigFileLike {
  load(path: string): number;
  save(path: string): number;
  set_value(section: string, key: string, value: unknown): void;
  get_value(section: string, key: string, def?: unknown): unknown;
  has_section_key(section: string, key: string): boolean;
  erase_section_key(section: string, key: string): void;
  get_sections(): GArrayLike;
  get_section_keys(section: string): GArrayLike;
}
export interface PlayerLike {
  stream: unknown;
  bus: string;
  volume_db: number;
  pitch_scale: number;
  playing: boolean;
  play(from?: number): void;
  stop(): void;
  queue_free(): void;
  set_name(name: string): void;
}
export interface NodeLike {
  add_child(node: any): void;
  remove_child(node: any): void;
}
export interface GodotSlice {
  ConfigFile: new () => ConfigFileLike;
  DirAccess: { rename_absolute(from: string, to: string): number; remove_absolute(path: string): number };
  FileAccess: { file_exists(path: string): boolean };
  ResourceLoader: {
    exists(path: string, typeHint?: string): boolean;
    load(path: string, typeHint?: string, cacheMode?: number): unknown;
    load_threaded_request(path: string, typeHint?: string, useSubThreads?: boolean, cacheMode?: number): number;
    load_threaded_get_status(path: string): number;
    load_threaded_get(path: string): unknown;
  };
  AudioServer: { get_bus_index(name: string): number; get_bus_volume_db(idx: number): number; set_bus_volume_db(idx: number, db: number): void; is_bus_mute?(idx: number): boolean };
  AudioStreamPlayer: new () => PlayerLike;
  OS: { get_cmdline_user_args(): GArrayLike };
  ProjectSettings: { has_setting(name: string): boolean; get_setting(name: string): unknown };
  Callable: { create(fn: (...args: any[]) => any): unknown };
  is_instance_valid(obj: unknown): boolean;
}

export const godot = (): GodotSlice => require("godot") as GodotSlice;

/** PackedStringArray / GArray are not iterable from JS: size() and get(i). */
export const toStrings = (a: GArrayLike): string[] => {
  const out: string[] = [];
  for (let i = 0; i < a.size(); i++) out.push(String(a.get(i)));
  return out;
};
