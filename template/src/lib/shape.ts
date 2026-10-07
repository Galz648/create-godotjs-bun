// The data shape check shared by devState (relaunch) and hot() (live swap): keys and value types, nothing else.
// A null shape (null, undefined, a function, an empty array) is a wildcard that matches anything.

export type Shape = null | "number" | "string" | "boolean" | { arr: Shape } | { obj: { [key: string]: Shape } };

export function shapeOf(value: unknown): Shape {
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return { arr: value.length > 0 ? shapeOf(value[0]) : null };
  if (value !== null && typeof value === "object") {
    const obj: { [key: string]: Shape } = {};
    for (const key of Object.keys(value)) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) obj[key] = shapeOf(v);
    }
    return { obj };
  }
  return null; // null, undefined, functions: unknown, matches anything
}

export function fits(a: Shape, b: Shape): boolean {
  if (a === null || b === null) return true;
  if (typeof a === "string" || typeof b === "string") return a === b;
  if ("arr" in a || "arr" in b) return "arr" in a && "arr" in b && fits(a.arr, b.arr);
  const ka = Object.keys(a.obj).sort();
  const kb = Object.keys(b.obj).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && fits(a.obj[k], b.obj[k]));
}

/** The data part of an object graph: own enumerable fields, no functions, cycles cut, depth capped. For shapeOf only. */
export function plainData(value: unknown, seen: Set<object> = new Set(), depth = 0): unknown {
  if (value === null || typeof value !== "object") return typeof value === "function" ? undefined : value;
  if (seen.has(value) || depth > 8) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.slice(0, 1).map((v) => plainData(v, seen, depth + 1));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = plainData((value as Record<string, unknown>)[key], seen, depth + 1);
    return out;
  } finally {
    seen.delete(value);
  }
}
