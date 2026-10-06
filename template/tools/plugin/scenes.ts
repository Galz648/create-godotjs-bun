// Build-time check of `@gd.onready("Path")` against the project's scenes.
//
// Reads `.tscn` text (no Godot process): which scripts each scene attaches, and each node's name,
// parent, type. From that it answers "does this path exist under the node this script is attached to,
// and is the node's type compatible with the field's declared type". Everything it cannot prove is
// silent: the check only reports what is certain. The result is a warning, never an error.
//
// Not modelled (documented in docs/design/tooling-diagnostics.md): instanced sub-scenes and inherited
// scenes (their inner nodes are not in the .tscn), `%Unique` names, `..` and absolute paths, `:property`
// suffixes, nodes added in code, scripts attached by code only.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface TscnNode {
  name: string;
  /** Engine type from `type="..."`. Undefined for an instanced scene or an inherited-node override. */
  type?: string;
  /** `parent="..."`. Undefined for the scene root. */
  parent?: string;
  /** `instance=ExtResource(...)` or `instance_placeholder`: the node's inner nodes live in another scene. */
  instance: boolean;
  /** Id of `script = ExtResource("id")` on this node. */
  script?: string;
}

export interface TscnScene {
  /** ext_resource id -> { type, path } */
  resources: Map<string, { type: string; path: string }>;
  nodes: TscnNode[];
}

/** Reads one `key=value` run of a section header, starting at `i`. Returns attrs and the index after `]`. */
function parseHeader(line: string): { tag: string; attrs: Map<string, string> } | null {
  if (!line.startsWith("[") || !line.trimEnd().endsWith("]")) return null;
  const body = line.trimEnd().slice(1, -1);
  const tag = /^\s*([A-Za-z_]+)/.exec(body);
  if (!tag) return null;
  const attrs = new Map<string, string>();
  let i = tag[0].length;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    const eq = body.indexOf("=", i);
    if (eq < 0) break;
    const key = body.slice(i, eq).trim();
    i = eq + 1;
    const start = i;
    if (body[i] === '"') {
      i++;
      while (i < body.length && body[i] !== '"') i += body[i] === "\\" ? 2 : 1;
      i++;
    } else {
      // bare value, possibly with a balanced (...) or [...] group: ExtResource("1"), ["a", "b"], 42
      let depth = 0;
      let quoted = false;
      while (i < body.length) {
        const c = body[i];
        if (quoted) {
          if (c === "\\") i++;
          else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if (depth === 0 && /\s/.test(c)) break;
        i++;
      }
    }
    attrs.set(key, body.slice(start, i));
  }
  return { tag: tag[1], attrs };
}

function unquote(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return value;
}

function extResourceId(value: string): string | undefined {
  return /^ExtResource\(\s*"?([^")\s]+)"?\s*\)$/.exec(value.trim())?.[1];
}

/** Bracket and quote balance of a property value, to find where a multi-line value ends. */
function unbalanced(text: string): boolean {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
  }
  return quoted || depth > 0;
}

/** Parses the parts of a text scene the check needs. Tolerant: an unknown section or property is skipped. */
export function parseTscn(text: string): TscnScene {
  const scene: TscnScene = { resources: new Map(), nodes: [] };
  const lines = text.split(/\r?\n/);
  let current: TscnNode | null = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (line.startsWith("[")) {
      const header = parseHeader(line);
      if (!header) continue;
      current = null;
      if (header.tag === "ext_resource") {
        const id = unquote(header.attrs.get("id"));
        const path = unquote(header.attrs.get("path"));
        const type = unquote(header.attrs.get("type"));
        if (id !== undefined && path !== undefined) scene.resources.set(id, { type: type ?? "", path });
      } else if (header.tag === "node") {
        const name = unquote(header.attrs.get("name"));
        if (name === undefined) continue;
        current = {
          name,
          type: unquote(header.attrs.get("type")),
          parent: unquote(header.attrs.get("parent")),
          instance: header.attrs.has("instance") || header.attrs.has("instance_placeholder"),
        };
        scene.nodes.push(current);
      }
      continue;
    }
    // A property line. A value can run over several lines (arrays, dictionaries): skip to its end.
    const eq = /^([A-Za-z_][\w/.]*)\s*=\s*(.*)$/.exec(line);
    if (!eq) continue;
    let value = eq[2];
    while (unbalanced(value) && n + 1 < lines.length) value += "\n" + lines[++n];
    if (current && eq[1] === "script") current.script = extResourceId(value);
  }
  return scene;
}

/** Superclass of each engine class name, read from `class A extends B` in .d.ts text. */
export class Hierarchy {
  private parents = new Map<string, string>();

  addTypings(text: string): void {
    // `class Node<Map extends NodePathMap = any> extends Object implements ...` and `class Label extends Control`.
    const re = /\bclass\s+(\w+)(?:<[^\n{]*?>)?\s+extends\s+(\w+)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) this.parents.set(m[1], m[2]);
  }

  knows(name: string): boolean {
    return name === "Object" || this.parents.has(name);
  }

  /** True/false when both are known classes; undefined when either is not in the hierarchy. */
  isA(type: string, ancestor: string): boolean | undefined {
    if (!this.knows(type) || !this.knows(ancestor)) return undefined;
    const seen = new Set<string>();
    let t = type;
    for (;;) {
      if (t === ancestor) return true;
      if (t === "Object") return false;
      const parent = this.parents.get(t);
      // A chain that leaves the known classes cannot prove "no".
      if (parent === undefined || seen.has(t)) return undefined;
      seen.add(t);
      t = parent;
    }
  }
}

export interface SceneFile {
  /** `res://...` path. */
  res: string;
  scene: TscnScene;
}

/** A path the check understands: plain `A/B` or `./A/B` segments. Anything else is skipped on purpose. */
export function plainOnreadyPath(path: string): string[] | null {
  if (path === "" || path.startsWith("/") || path.includes("%") || path.includes(":") || path.includes("\\")) return null;
  const segments = path.split("/");
  if (segments.some((s) => s === ".." || s === "")) return null;
  return segments.filter((s) => s !== ".");
}

interface Placement {
  file: SceneFile;
  /** Path of the node the script is attached to, relative to the scene root ("" for the root). */
  at: string;
}

export class SceneIndex {
  private byScript: Map<string, Placement[]> | null = null;
  private readonly hierarchy: Hierarchy;

  /**
   * `scenes` are already read. Use `SceneIndex.fromProject` for a real project.
   * `scriptRes` maps an absolute script file to its `res://` path.
   */
  constructor(
    private readonly scenes: SceneFile[],
    hierarchy: Hierarchy,
    private readonly scriptRes: (file: string) => string | null,
  ) {
    this.hierarchy = hierarchy;
  }

  static fromProject(root: string): SceneIndex {
    const real = realpathSync(root);
    const files = findScenes(real).map((abs) => ({
      res: "res://" + relative(real, abs).split("\\").join("/"),
      scene: parseTscn(readFileSync(abs, "utf8")),
    }));
    const hierarchy = new Hierarchy();
    if (files.length > 0) {
      for (const dts of typingFiles(real)) hierarchy.addTypings(readFileSync(dts, "utf8"));
    }
    return new SceneIndex(files, hierarchy, (file) => {
      const rel = relative(real, file);
      return rel.startsWith("..") ? null : "res://" + rel.split("\\").join("/");
    });
  }

  get sceneCount(): number {
    return this.scenes.length;
  }

  private placements(script: string): Placement[] {
    if (!this.byScript) {
      this.byScript = new Map();
      for (const file of this.scenes) {
        const keys = new Map<TscnNode, string>();
        for (const node of file.scene.nodes) {
          keys.set(node, nodeKey(node));
          if (node.script === undefined) continue;
          const res = file.scene.resources.get(node.script);
          if (!res || res.path === "") continue;
          const list = this.byScript.get(res.path) ?? [];
          list.push({ file, at: keys.get(node)! });
          this.byScript.set(res.path, list);
        }
      }
    }
    return this.byScript.get(script) ?? [];
  }

  /**
   * Messages (without a source position) for one `@onready("path")` field of `scriptFile`.
   * `fieldType` is the declared type's class name when it is a single plain type, else null.
   */
  checkOnready(scriptFile: string, path: string, fieldType: string | null): string[] {
    if (this.scenes.length === 0) return [];
    const segments = plainOnreadyPath(path);
    if (!segments) return [];
    const script = this.scriptRes(scriptFile);
    if (!script) return [];
    const placed = this.placements(script);
    if (placed.length === 0) return [];

    const missing: string[] = [];
    const mismatched: string[] = [];
    let found = false; // exists, or cannot be ruled out, in at least one attaching scene
    for (const { file, at } of placed) {
      const target = [at, ...segments].filter((s) => s !== "").join("/");
      const verdict = lookup(file.scene, target);
      if (verdict.kind === "missing") {
        missing.push(`${file.res} (script on ${at === "" ? "the root node" : `node "${at}"`})`);
        continue;
      }
      found = true;
      if (verdict.kind === "node" && verdict.type && fieldType) {
        if (this.hierarchy.isA(verdict.type, fieldType) === false) {
          mismatched.push(
            `node "${target === "" ? file.scene.nodes[0]?.name : target}" in ${file.res} is a ${verdict.type}, which is not a ${fieldType}`,
          );
        }
      }
    }
    const out: string[] = [];
    if (!found && missing.length > 0) {
      out.push(
        `@onready("${path}"): no such node in ${missing.join(", ")}. get_node returns null and the field is set to null.`,
      );
    }
    for (const m of mismatched) {
      out.push(`@onready("${path}") is declared as ${fieldType}, but ${m}.`);
    }
    return out;
  }
}

function nodeKey(node: TscnNode): string {
  if (node.parent === undefined) return "";
  return node.parent === "." ? node.name : `${node.parent}/${node.name}`;
}

type Lookup = { kind: "node"; type?: string } | { kind: "missing" } | { kind: "unknown" };

/**
 * Resolves a scene-relative node path. "unknown" when it passes through an instanced scene or the scene
 * inherits another one (those inner nodes are not in this file).
 */
function lookup(scene: TscnScene, target: string): Lookup {
  const root = scene.nodes[0];
  if (!root) return { kind: "unknown" };
  const byKey = new Map<string, TscnNode>();
  for (const node of scene.nodes) byKey.set(nodeKey(node), node);
  const exact = byKey.get(target);
  if (exact) return { kind: "node", type: exact.instance ? undefined : exact.type };
  if (root.instance) return { kind: "unknown" }; // inherited scene: the base scene's nodes are not listed
  const parts = target.split("/");
  for (let n = 1; n < parts.length; n++) {
    const ancestor = byKey.get(parts.slice(0, n).join("/"));
    if (ancestor?.instance) return { kind: "unknown" };
  }
  return { kind: "missing" };
}

function findScenes(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, top: boolean) => {
    // A folder with its own project.godot is a separate Godot project: its scenes are not ours.
    if (!top && existsSync(join(dir, "project.godot"))) return;
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".godot" || entry === ".git" || entry.startsWith(".")) continue;
      const abs = join(dir, entry);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(abs, false);
      else if (entry.endsWith(".tscn")) found.push(abs);
    }
  };
  walk(root, true);
  return found.sort();
}

function typingFiles(root: string): string[] {
  const files: string[] = [];
  // Stand-in typings first: the generated ones (when `bun run types` has been run) refine them.
  files.push(join(import.meta.dir, "types/godot.d.ts"));
  const dir = join(root, "typings");
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir).sort()) {
      if (/^godot\d*\.gen\.d\.ts$/.test(entry)) files.push(join(dir, entry));
    }
  }
  return files;
}
