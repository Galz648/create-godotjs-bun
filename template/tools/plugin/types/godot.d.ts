// Type-checker stand-in for the external "godot" module. Not bundled.
// Bun keeps `import ... from "godot"` external; this file only classifies exports.
export class Object {}

export class Node extends Object {
  get_node(path: string): Node | null;
  get_name(): string;
  set_script(script: Resource): void;
  connect(signal: string, callable: Callable, flags?: number): number;
  disconnect(signal: string, callable: Callable): void;
  is_connected(signal: string, callable: Callable): boolean;
}

export class CanvasItem extends Node {
  modulate: Color;
}
export class Node2D extends CanvasItem {
  position: Vector2;
  get_position(): Vector2;
}
export class Node3D extends Node {
  position: Vector3;
}
export class Control extends CanvasItem {
  size: Vector2;
}
export class Label extends Control {}
export class Sprite2D extends Node2D {}

export class Resource extends Object {}
export class Script extends Resource {
  call(method: string, ...args: unknown[]): unknown;
}
export class GDScript extends Script {}
export class ResourceLoader {
  static load(path: string, typeHint?: string, cacheMode?: number): Resource;
}

export class Callable {
  static create(fn: (...args: never[]) => unknown): Callable;
  static create(owner: object, fn: (...args: never[]) => unknown): Callable;
}

export class Signal<T extends (...args: never[]) => void = (...args: never[]) => void> {
  connect(fn: T | Callable, flags?: number): void;
  disconnect(fn: T | Callable): void;
  is_connected(fn: T | Callable): boolean;
  emit(...args: Parameters<T>): void;
  as_promise(): Promise<unknown[]>;
}

export class Timer extends Node {
  timeout: Signal<() => void>;
}

export class GArray {
  static create(items: unknown[]): GArray;
  filter(fn: (value: never) => boolean): GArray;
  map(fn: (value: never) => unknown): GArray;
  size(): number;
  get(index: number): unknown;
}

export class GDictionary {
  set(key: unknown, value: unknown): void;
  has(key: unknown): boolean;
}

/** Marker the engine uses for Array[int]. A symbol, not a constructor. */
export const IntegerType: unique symbol;
/** Marker the engine uses for Array[float]. */
export const FloatType: unique symbol;

export class Vector2 {
  x: number;
  y: number;
  constructor(x?: number, y?: number);
}
export class Vector3 {
  x: number;
  y: number;
  z: number;
  constructor(x?: number, y?: number, z?: number);
}
export class Color {
  r: number;
  g: number;
  b: number;
  a: number;
  constructor(r?: number, g?: number, b?: number, a?: number);
}
