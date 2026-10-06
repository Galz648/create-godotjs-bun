// Bun plugin. Rewrites project TypeScript before Bun emits the bundle, then the build
// composes Bun's source map with the edit map so stack lines stay on the original file.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { composeMappings, type TransformMap } from "./sourcemap.ts";
import { transformSourceFile } from "./transform.ts";

const PLUGIN_DIR = import.meta.dir;
const GODOT_DTS = join(PLUGIN_DIR, "types/godot.d.ts");
const ANNOT_DTS = join(PLUGIN_DIR, "types/godot.annotations.d.ts");

const NEEDS =
  /export\s*\.\s*array\s*\(|export\s*\.\s*object\s*\(|\.onready\s*\(|\.connect\s*\(|\.disconnect\s*\(|\.is_connected\s*\(|tween_callback\s*\(|\.set_script\s*\(|\bgd\s*\.\s*export\s*\(|Callable\s*\.\s*create\s*\(|\.filter\s*\(|\.map\s*\(/;

const CALLABLE_HELPER = `import { Callable } from "godot";

const owners = new WeakMap<object, WeakMap<Function, Function>>();

// Stock JSCallable equality ignores the Godot object. One wrapped function per
// (owner, fn) pair makes connect / disconnect / == follow that pair instead.
export function callableWithOwner(owner: object, fn: Function): Callable {
  let fns = owners.get(owner);
  if (!fns) {
    fns = new WeakMap();
    owners.set(owner, fns);
  }
  let wrapped = fns.get(fn);
  if (!wrapped) {
    wrapped = function (...args: unknown[]) {
      return Reflect.apply(fn, owner, args);
    };
    fns.set(fn, wrapped);
  }
  return Callable.create(wrapped as (...args: never[]) => unknown);
}
`;

export interface Session {
  plugin: Bun.BunPlugin;
  maps: Map<string, TransformMap>;
  root: string;
}

export function createSession(root: string): Session {
  const projectRoot = realpathSync(root);
  const maps = new Map<string, TransformMap>();
  const program = createProgram(projectRoot);
  const checker = program.getTypeChecker();

  const plugin: Bun.BunPlugin = {
    name: "godotjs-tooling",
    setup(build) {
      build.onResolve({ filter: /^godotjs-tooling\/callable$/ }, () => ({
        path: "godotjs-tooling/callable",
        namespace: "godotjs-tooling",
      }));
      build.onLoad({ filter: /.*/, namespace: "godotjs-tooling" }, () => ({
        contents: CALLABLE_HELPER,
        loader: "ts",
      }));
      // Only project sources. A filter on every .ts file makes Bun rebuild
      // dependencies (starter pulls in effect) on each run.
      const projectSrc = new RegExp(`^${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(src|gen)/.*\\.tsx?$`);
      build.onLoad({ filter: projectSrc }, (args) => {
        if (args.namespace && args.namespace !== "file") return;
        if (!args.path.endsWith(".ts") || args.path.endsWith(".d.ts")) return;
        let file = args.path;
        try {
          file = realpathSync(args.path);
        } catch {
          return;
        }
        if (file.includes(`${join("node_modules", "")}`) || file.startsWith(PLUGIN_DIR)) return;
        const text = readFileSync(file, "utf8");
        if (!NEEDS.test(text)) return;
        const sourceFile = program.getSourceFile(file);
        if (!sourceFile) return;
        const result = transformSourceFile(sourceFile, checker);
        if (!result) return;
        for (const warning of result.warnings) console.warn(`[tooling] ${warning}`);
        if (result.map.generatedText === result.map.originalText) return;
        maps.set(file, result.map);
        return { contents: result.map.generatedText, loader: "ts" };
      });
    },
  };

  return { plugin, maps, root: projectRoot };
}

export function composeOutputMap(map: {
  version: number;
  file?: string;
  sources: string[];
  names?: string[];
  mappings: string;
  sourcesContent?: (string | null)[];
  sourceRoot?: string;
}, mapFile: string, session: Session) {
  return composeMappings(map, (source) => findTransform(source, mapFile, session));
}

function findTransform(source: string | null, mapFile: string, session: Session): TransformMap | undefined {
  if (!source) return undefined;
  const candidates = [
    source,
    resolve(dirname(mapFile), source),
    resolve(session.root, source),
    resolve(join(session.root, ".godot/GodotJS"), source),
  ];
  for (const candidate of candidates) {
    try {
      const hit = session.maps.get(realpathSync(candidate));
      if (hit) return hit;
    } catch {
      /* not a real file */
    }
  }
  for (const [file, transform] of session.maps) {
    if (file.endsWith(source) || source.endsWith(file)) return transform;
  }
  return undefined;
}

function createProgram(root: string): ts.Program {
  const files = listSources(root);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: false,
    noImplicitAny: false,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    experimentalDecorators: false,
    lib: ["lib.es2022.d.ts"],
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (file) => fileExists(file);
  host.readFile = (file) => readFile(file);
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((name) => {
      const resolved = resolveModule(name, containingFile);
      if (!resolved) return undefined;
      return {
        resolvedFileName: resolved,
        extension: resolved.endsWith(".d.ts") ? ts.Extension.Dts : ts.Extension.Ts,
        isExternalLibraryImport: !name.startsWith("."),
      };
    });
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map((literal) => {
      const resolved = resolveModule(literal.text, containingFile);
      if (!resolved) return { resolvedModule: undefined };
      return {
        resolvedModule: {
          resolvedFileName: resolved,
          extension: resolved.endsWith(".d.ts") ? ts.Extension.Dts : ts.Extension.Ts,
          isExternalLibraryImport: !literal.text.startsWith("."),
        },
      };
    });
  return ts.createProgram({ rootNames: files, options, host });
}

function resolveModule(name: string, containingFile: string): string | undefined {
  if (name === "godot") return GODOT_DTS;
  if (name === "godot.annotations") return ANNOT_DTS;
  if (!name.startsWith(".")) return undefined;
  const base = resolve(dirname(containingFile), name);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, join(base, "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
  }
  return undefined;
}

function listSources(root: string): string[] {
  const files: string[] = [];
  const src = join(root, "src");
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".godot") continue;
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        // src/lib is shared code. Imports still resolve; it is not a script root.
        if (abs === join(src, "lib")) continue;
        walk(abs);
        continue;
      }
      if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) files.push(realpathSync(abs));
    }
  };
  walk(src);
  return files;
}
