// What the plugin knows about engine classes it has no declaration for. The program the checks run on resolves
// "godot" to a small stand-in file (20 classes); the full class list is the generated typings (`bun run types`),
// which only the scene check reads. This reads the same files for the class hierarchy, once per build.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { Hierarchy } from "./scenes.ts";

let root: string | undefined;
let hierarchy: Hierarchy | undefined;

export function setEngineClassRoot(projectRoot: string): void {
  root = projectRoot;
  hierarchy = undefined;
}

/** The project root the generated typings are read from (undefined before a session sets it). */
export function engineClassRoot(): string | undefined {
  return root;
}

function load(): Hierarchy {
  if (hierarchy) return hierarchy;
  hierarchy = new Hierarchy();
  hierarchy.addTypings(readFileSync(join(import.meta.dir, "types/godot.d.ts"), "utf8"));
  const dir = root ? join(root, "typings") : undefined;
  if (dir && existsSync(dir)) {
    for (const entry of readdirSync(dir).sort()) {
      if (/^godot\d*\.gen\.d\.ts$/.test(entry)) hierarchy.addTypings(readFileSync(join(dir, entry), "utf8"));
    }
  }
  return hierarchy;
}

/** The name of a class imported from "godot" that the program has no declaration for, or null. */
export function importedEngineClass(expr: ts.Node, checker: ts.TypeChecker): string | null {
  if (!ts.isIdentifier(expr)) return null;
  const symbol = checker.getSymbolAtLocation(expr);
  for (const decl of symbol?.declarations ?? []) {
    if (!ts.isImportSpecifier(decl)) continue;
    const from = decl.parent.parent.parent.moduleSpecifier;
    if (ts.isStringLiteral(from) && from.text === "godot") return (decl.propertyName ?? decl.name).text;
  }
  return null;
}

export function engineKind(name: string): "node" | "resource" | undefined {
  const h = load();
  if (h.isA(name, "Node")) return "node";
  if (h.isA(name, "Resource")) return "resource";
  return undefined;
}

export function engineClassKnown(): boolean {
  return load().knows("Area2D");
}

/** True/false when both classes are in the known hierarchy (stand-in plus generated typings); undefined when not. */
export function engineIsA(name: string, ancestor: string): boolean | undefined {
  return load().isA(name, ancestor);
}
