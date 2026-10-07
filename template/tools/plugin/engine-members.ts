// Which engine members hand out a builtin value type or a Packed*Array, by class. The program the checks run on resolves "godot" to
// a small stand-in file, so the checker cannot say what `node.rotation` is. Two sources fill the table:
//   1. a built-in seed (below): the members a game touches most, so the checks work in a project with no generated typings;
//   2. the generated typings (`typings/godot*.gen.d.ts`, `bun run types`) when the project has them: every getter and every
//      method whose return type is one of those types.
// Both are read once per build. A member that is in neither stays unknown, and an unknown member is never reported.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { engineClassRoot } from "./engine-classes.ts";

/** Builtin types that are copied on every property read (a write to a member of one is lost) and print as `[object Object]`. */
export const VALUE_TYPES = new Set([
  "Vector2", "Vector2i", "Vector3", "Vector3i", "Vector4", "Vector4i", "Color", "Rect2", "Rect2i",
  "Transform2D", "Transform3D", "Basis", "Quaternion", "Plane", "AABB", "Projection",
]);

/** Builtin non-iterable array types. */
export const PACKED_TYPES = new Set([
  "PackedByteArray", "PackedInt32Array", "PackedInt64Array", "PackedFloat32Array", "PackedFloat64Array",
  "PackedStringArray", "PackedVector2Array", "PackedVector3Array", "PackedColorArray", "PackedVector4Array",
]);

/** Types whose `String(v)`, template and `JSON.stringify` are `[object Object]` / `{}` (ticket 267). */
export const STRINGLESS_TYPES = new Set([...VALUE_TYPES, ...PACKED_TYPES, "NodePath"]);

const interesting = (t: string) => STRINGLESS_TYPES.has(t);

interface Table {
  parents: Map<string, string>;
  props: Map<string, Map<string, string>>;
  methods: Map<string, Map<string, string | null>>; // null: overloads disagree
}

function add<V>(map: Map<string, Map<string, V>>, cls: string, name: string, value: V): void {
  let inner = map.get(cls);
  if (!inner) map.set(cls, (inner = new Map()));
  inner.set(name, value);
}

function addMethod(t: Table, cls: string, name: string, type: string): void {
  const seen = t.methods.get(cls)?.get(name);
  add(t.methods, cls, name, seen === undefined || seen === type ? type : null);
}

// -- seed ---------------------------------------------------------------------------------------------------------
const SEED_PARENTS: Record<string, string> = {
  CanvasItem: "Node", Node2D: "CanvasItem", Control: "CanvasItem", Sprite2D: "Node2D", Camera2D: "Node2D", Label: "Control", ColorRect: "Control",
  CollisionObject2D: "Node2D", PhysicsBody2D: "CollisionObject2D", CharacterBody2D: "PhysicsBody2D", RigidBody2D: "PhysicsBody2D", StaticBody2D: "PhysicsBody2D", Area2D: "CollisionObject2D",
  Node3D: "Node", VisualInstance3D: "Node3D", GeometryInstance3D: "VisualInstance3D", MeshInstance3D: "GeometryInstance3D", Sprite3D: "GeometryInstance3D",
  CollisionObject3D: "Node3D", PhysicsBody3D: "CollisionObject3D", CharacterBody3D: "PhysicsBody3D", RigidBody3D: "PhysicsBody3D", StaticBody3D: "PhysicsBody3D", Area3D: "CollisionObject3D",
  Light3D: "VisualInstance3D", DirectionalLight3D: "Light3D", OmniLight3D: "Light3D", SpotLight3D: "Light3D", Camera3D: "Node3D", Marker3D: "Node3D", Path3D: "Node3D", PathFollow3D: "Node3D",
  Polygon2D: "Node2D", CollisionPolygon2D: "Node2D",
  Resource: "RefCounted", Shape3D: "Resource", BoxShape3D: "Shape3D", Mesh: "Resource", PrimitiveMesh: "Mesh", BoxMesh: "PrimitiveMesh", PlaneMesh: "PrimitiveMesh",
  Material: "Resource", BaseMaterial3D: "Material", StandardMaterial3D: "BaseMaterial3D", Curve3D: "Resource", Curve2D: "Resource", AStar3D: "RefCounted", AStar2D: "RefCounted",
};

// class -> member -> type, for getters. Names are the typings' own.
const SEED_PROPS: Record<string, Record<string, string>> = {
  Node2D: { position: "Vector2", scale: "Vector2", global_position: "Vector2", global_scale: "Vector2", transform: "Transform2D", global_transform: "Transform2D" },
  Node3D: {
    position: "Vector3", rotation: "Vector3", rotation_degrees: "Vector3", scale: "Vector3", global_position: "Vector3", global_rotation: "Vector3",
    global_rotation_degrees: "Vector3", transform: "Transform3D", global_transform: "Transform3D", basis: "Basis", global_basis: "Basis", quaternion: "Quaternion",
  },
  Control: { position: "Vector2", size: "Vector2", global_position: "Vector2", scale: "Vector2", pivot_offset: "Vector2", custom_minimum_size: "Vector2" },
  CanvasItem: { modulate: "Color", self_modulate: "Color" },
  GeometryInstance3D: { custom_aabb: "AABB" },
  Sprite2D: { offset: "Vector2" },
  ColorRect: { color: "Color" },
  Polygon2D: { polygon: "PackedVector2Array" },
  CollisionPolygon2D: { polygon: "PackedVector2Array" },
  CharacterBody2D: { velocity: "Vector2" },
  CharacterBody3D: { velocity: "Vector3" },
  RigidBody2D: { linear_velocity: "Vector2", center_of_mass: "Vector2" },
  RigidBody3D: { linear_velocity: "Vector3", angular_velocity: "Vector3", center_of_mass: "Vector3" },
  Area3D: { gravity_direction: "Vector3" },
  Light3D: { light_color: "Color" },
  BoxShape3D: { size: "Vector3" },
  BoxMesh: { size: "Vector3" },
  PlaneMesh: { size: "Vector2" },
  BaseMaterial3D: { albedo_color: "Color", uv1_scale: "Vector3", uv1_offset: "Vector3" },
  // The value types' own members that are value types: also a copy on every read (ticket 265, measured on the stock engine).
  Transform3D: { basis: "Basis", origin: "Vector3" },
  Basis: { x: "Vector3", y: "Vector3", z: "Vector3" },
  Transform2D: { x: "Vector2", y: "Vector2", origin: "Vector2" },
  AABB: { position: "Vector3", size: "Vector3", end: "Vector3" },
  Rect2: { position: "Vector2", size: "Vector2", end: "Vector2" },
  Rect2i: { position: "Vector2i", size: "Vector2i", end: "Vector2i" },
  Plane: { normal: "Vector3" },
  Projection: { x: "Vector4", y: "Vector4", z: "Vector4", w: "Vector4" },
};

const SEED_METHODS: Record<string, Record<string, string>> = {
  Control: { get_rect: "Rect2", get_global_rect: "Rect2" },
  Curve3D: { get_baked_points: "PackedVector3Array" },
  Curve2D: { get_baked_points: "PackedVector2Array" },
  AStar3D: { get_point_path: "PackedVector3Array", get_id_path: "PackedInt64Array" },
  AStar2D: { get_point_path: "PackedVector2Array", get_id_path: "PackedInt64Array" },
  Mesh: { get_faces: "PackedVector3Array" },
  OS: { get_cmdline_args: "PackedStringArray", get_cmdline_user_args: "PackedStringArray" },
  DirAccess: { get_files: "PackedStringArray", get_directories: "PackedStringArray", get_files_at: "PackedStringArray", get_directories_at: "PackedStringArray" },
  Image: { get_data: "PackedByteArray" },
};

// Methods of the value types that return a value type: the common ones, so `${v.normalized()}` or `new Quaternion(Basis.from_euler(e))`
// is known without generated typings (with them, every such method is read from the typings).
const SELF_RETURNING: Record<string, string[]> = {
  Vector2: ["normalized", "abs", "floor", "ceil", "round", "sign", "lerp", "slerp", "rotated", "project", "slide", "bounce", "reflect", "clamp", "clampf", "snapped", "snappedf", "limit_length", "move_toward", "orthogonal", "posmod", "from_angle"],
  Vector3: ["normalized", "abs", "floor", "ceil", "round", "sign", "lerp", "slerp", "rotated", "project", "slide", "bounce", "reflect", "clamp", "clampf", "snapped", "snappedf", "limit_length", "move_toward", "cross", "direction_to", "posmod", "inverse"],
  Vector4: ["normalized", "abs", "floor", "ceil", "round", "sign", "lerp", "clamp", "snapped", "inverse"],
  Basis: ["from_euler", "looking_at", "from_scale", "inverse", "transposed", "orthonormalized", "scaled", "rotated", "slerp"],
  Quaternion: ["normalized", "inverse", "slerp", "slerpni", "spherical_cubic_interpolate", "from_euler"],
  Transform3D: ["looking_at", "rotated", "rotated_local", "translated", "translated_local", "scaled", "scaled_local", "inverse", "affine_inverse", "orthonormalized", "interpolate_with"],
  Transform2D: ["rotated", "rotated_local", "translated", "translated_local", "scaled", "scaled_local", "inverse", "affine_inverse", "orthonormalized", "interpolate_with"],
  Color: ["lerp", "darkened", "lightened", "inverted", "blend", "from_hsv"],
  AABB: ["abs", "expand", "grow", "merge", "intersection"],
  Rect2: ["abs", "expand", "grow", "merge", "intersection"],
};
const OTHER_RETURNING: Record<string, Record<string, string>> = {
  Basis: { get_euler: "Vector3", get_scale: "Vector3", get_rotation_quaternion: "Quaternion" },
  Quaternion: { get_euler: "Vector3", get_axis: "Vector3" },
  Transform3D: {},
  AABB: { get_center: "Vector3", get_end: "Vector3" },
  Rect2: { get_center: "Vector2", get_end: "Vector2" },
};

function seed(): Table {
  const t: Table = { parents: new Map(Object.entries(SEED_PARENTS)), props: new Map(), methods: new Map() };
  for (const [cls, members] of Object.entries(SEED_PROPS)) for (const [name, type] of Object.entries(members)) add(t.props, cls, name, type);
  for (const [cls, names] of Object.entries(SELF_RETURNING)) for (const name of names) add(t.methods, cls, name, cls);
  for (const [cls, members] of Object.entries(OTHER_RETURNING)) for (const [name, type] of Object.entries(members)) add(t.methods, cls, name, type);
  for (const [cls, members] of Object.entries(SEED_METHODS)) for (const [name, type] of Object.entries(members)) add(t.methods, cls, name, type);
  return t;
}

// -- generated typings ----------------------------------------------------------------------------------------------
// Shape (4-space class, 8-space members): `    class Node3D<Map extends NodePathMap = any> extends Node<Map> {` ... `        get position(): Vector3`
// ... `        get_baked_points(): PackedVector3Array` ... `    }`.
function addTypings(t: Table, text: string): void {
  let cls: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("    ")) {
      if (line.charCodeAt(4) !== 32) {
        const head = /^ {4}(?:abstract )?class (\w+)(?:<[^\n]*?>)?(?: extends (\w+))?/.exec(line);
        cls = head ? head[1] : null;
        if (head?.[2]) t.parents.set(head[1], head[2]);
        continue;
      }
      if (!cls) continue;
      const getter = /^ {8}get (\w+)\(\): (\w+)\s*$/.exec(line);
      if (getter) {
        if (interesting(getter[2])) add(t.props, cls, getter[1], getter[2]);
        continue;
      }
      const method = /^ {8}(?:static )?(\w+)\([^)]*\): (\w+)\s*$/.exec(line);
      if (method && interesting(method[2])) addMethod(t, cls, method[1], method[2]);
    }
  }
}

let table: Table | undefined;
let tableRoot: string | undefined;

function load(): Table {
  const root = engineClassRoot();
  if (table && tableRoot === root) return table;
  const t = seed();
  const dir = root ? join(root, "typings") : undefined;
  if (dir && existsSync(dir)) {
    for (const entry of readdirSync(dir).sort()) {
      if (/^godot\d*\.gen\.d\.ts$/.test(entry)) addTypings(t, readFileSync(join(dir, entry), "utf8"));
    }
  }
  table = t;
  tableRoot = root;
  return t;
}

function lookup<V>(pick: (t: Table) => Map<string, Map<string, V>>, cls: string, member: string): V | null {
  const t = load();
  const seen = new Set<string>();
  for (let c: string | undefined = cls; c && !seen.has(c); c = t.parents.get(c)) {
    seen.add(c);
    const found = pick(t).get(c)?.get(member);
    if (found !== undefined) return found;
  }
  return null;
}

/** The value / packed type of the property `member` on engine class `cls` (inherited ones included), or null when unknown. */
export function engineProperty(cls: string, member: string): string | null {
  return lookup((t) => t.props, cls, member);
}

/** The value / packed type returned by the method `member` on engine class `cls`, or null when unknown or ambiguous. */
export function engineMethod(cls: string, member: string): string | null {
  return lookup((t) => t.methods, cls, member);
}

/** True when `cls` is a class the table has a hierarchy for or a member of. */
export function engineClassInTable(cls: string): boolean {
  const t = load();
  return t.parents.has(cls) || t.props.has(cls) || t.methods.has(cls);
}
