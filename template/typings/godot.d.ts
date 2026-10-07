// Minimal typings so `tsc` works before `bun run types`. That command parks this file at
// typings/godot.shim.d.ts.off (it merges badly with the generated `declare module "godot"`).
// `bun run types:shim` restores it. `Script.call("new")` lives in godot-extras.d.ts.
declare module "godot" {
  export const Variant: { Type: { TYPE_INT: number; TYPE_FLOAT: number; TYPE_STRING: number; TYPE_BOOL: number } };
  export class Resource {}
  export class PackedScene<T = any> {}
  export class Script extends Resource { call(method: string, ...args: any[]): any; }
  export class ResourceLoader {
    static load(path: string, typeHint?: string, cacheMode?: number): Resource;
  }
  // Same constraint as the generated typings (`Signal<(...args) => void>`), so scripts typecheck before and after `bun run types`.
  export class Signal<T extends (...args: any[]) => void = (...args: any[]) => void> {
    emit(...args: Parameters<T>): void;
    as_promise(): Promise<unknown>;
  }
  // Used by src/lib/godot-effect.ts (Effect projects).
  export class Callable { static create(fn: (...args: any[]) => any): Callable; }
  export function is_instance_valid(obj: any): boolean;
  export class Node {
    get_tree(): { quit(code?: number): void };
    add_child(node: Node): void;
    set_script(script: Script): void;
    has_signal(name: string): boolean;
    queue_free(): void;
    _ready?(): void;
    _process?(delta: number): void;
  }
  // The editor's gen/ scene typings name child classes. Label is the demo's @onready child.
  export class Label<T = any> extends Node {}
}
declare module "godot.annotations" {
  // Minimal shim; `bun run types` generates the real thing. Decorators are TC39 standard (use `accessor`), not experimentalDecorators.
  type Dec = (value: any, context: any) => any;
  export interface ClassBinder {
    (): Dec;
    export(type: unknown, options?: object): Dec;
    signal(): Dec;
  }
  export function createClassBinder(): ClassBinder;
}
