// Every .ts under src/ is a Bun entrypoint except src/lib/** and *.d.ts (shared code imported by scripts).
// gen/**/*.ts is compiled too: the editor loads those typings as scripts and errors if the JS is missing.
// Output mirrors the res:// path under .godot/GodotJS/ (root: the project directory). godot* stay external (engine-provided).
// tools/plugin rewrites exports, @onready, and connect(fn) before Bun emits. Source maps are composed
// back to the original file only when a file was actually rewritten.
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { composeOutputMap, createSession } from "./plugin/index.ts";
import { staleTypingsHint } from "./typings-hint.ts";

// Scripts run from the project root; resolve against it anyway so a move into tools/ cannot shift outdir or entrypoints.
const ROOT = join(import.meta.dir, "..");

function entrypoints(root: string): string[] {
  const files: string[] = [];
  const push = (path: string) => {
    const norm = path.replaceAll("\\", "/").replace(/^\.\//, "");
    if (norm.endsWith(".d.ts")) return;
    if (norm === "src/lib" || norm.startsWith("src/lib/")) return;
    files.push(join(root, norm));
  };
  for (const path of new Bun.Glob("src/**/*.ts").scanSync(root)) push(path);
  for (const path of new Bun.Glob("gen/**/*.ts").scanSync(root)) push(path);
  return files;
}

// A helper module (no default export) under src/ but outside src/lib/ is an entry AND a dependency of the script that
// imports it, so the bundler emits it first. If it imports `effect`, Effect's modules run before main.ts's polyfill
// import and the game fails at load with "TextEncoder is not defined". Ticket 203. Returns one line per such module.
export function sharedModuleWarnings(root: string, entries: string[]): string[] {
  const set = new Set(entries.map((e) => resolve(e)));
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const helpers = new Map<string, string>();
  const warnings: string[] = [];
  const hasDefault = (file: string) => /^\s*export\s+default\b/m.test(readFileSync(file, "utf8"));
  for (const file of set) {
    if (!file.includes(`${join(root, "src")}/`) || hasDefault(file)) continue;
    helpers.set(file, relative(root, file));
  }
  for (const file of set) {
    let imports: { path: string }[] = [];
    try { imports = transpiler.scanImports(readFileSync(file, "utf8")); } catch { continue; }
    for (const { path } of imports) {
      if (!path.startsWith(".")) continue;
      const base = resolve(dirname(file), path);
      const hit = [base, `${base}.ts`, join(base, "index.ts")].find((c) => helpers.has(c));
      if (hit) warnings.push(`warning: ${helpers.get(hit)} is shared code but sits outside src/lib/, so it is built as a script entry and bundled first into ${relative(root, file)}. If it imports effect the game fails to load ("TextEncoder is not defined"). Move it to src/lib/.`);
    }
  }
  return [...new Set(warnings)];
}

// Dev builds rename identifiers too (not whitespace or syntax, so stack frames and .map positions stay readable).
// WHY: Bun lowers each decorated class to a top-level `var _init = ...` that the constructor reads late, and without
// the renamer every decorated class in a bundle (same file or imported) gets the SAME `_init` (and the same
// per-accessor WeakMap names): the last class wins and accessors break ("never initialised"). The renamer makes them
// unique. Cost: class names are mangled in dev stack frames (method names and mapped positions are intact).
// GODOTJS_NO_MINIFY_IDS=1 turns it off: negative control for starter/tests/decorators-multi, or to see real class names
// when debugging a project with one decorated class. See docs/design/cross-file-decorators.md.
export const DEV_MINIFY = { identifiers: true } as const; // also what the bundle self-check builds with
function minifyOption(): boolean | { identifiers: boolean } {
  if (process.argv.includes("--minify")) return true;
  return process.env.GODOTJS_NO_MINIFY_IDS === "1" ? false : DEV_MINIFY;
}

/** `extraEntries`: absolute paths of additional entry files built in the same pass (tools/test.ts adds the test scene bundle); none for a normal build. */
export async function buildProject(root: string, extraEntries: string[] = []): Promise<boolean> {
  // Without node_modules Bun resolves some other `typescript` and the plugin dies with an obscure `ts.ScriptTarget` TypeError (ticket 242).
  const hasTypescript = (dir: string): boolean => existsSync(join(dir, "node_modules", "typescript", "package.json")) || (dirname(dir) !== dir && hasTypescript(dirname(dir)));
  if (!hasTypescript(root)) {
    console.error(`build failed: typescript is not installed in ${root} (no node_modules here or in a parent folder). Run \`bun install\` there first.`);
    return false;
  }
  const session = createSession(root);
  for (const line of sharedModuleWarnings(root, [...entrypoints(root), ...extraEntries])) console.warn(line);
  const outDir = join(root, ".godot/GodotJS");
  const result = await Bun.build({
    entrypoints: [...entrypoints(root), ...extraEntries],
    outdir: outDir,
    root, // keeps the src/ prefix so the output mirrors the res:// path
    format: "cjs",
    target: "browser", // no node builtins assumed
    external: ["godot", "godot.annotations", "godot-jsb", "jsb.core"],
    minify: minifyOption(),
    sourcemap: process.argv.includes("--minify") ? "none" : "external",
    plugins: [session.plugin],
    // `import.meta` is a syntax error in the CJS script the engine loads, and Effect's ConfigProvider.fromEnv contains
    // `import.meta?.env`, which Bun keeps in CJS output: a bundle using Config would not load ("import.meta only valid in
    // module code"). `{}` makes it `{}?.env`, which is undefined, as it is off Node. starter/tests/build-warnings checks this.
    define: { "import.meta": "{}" },
  });
  if (!result.success) { for (const l of result.logs) console.error(l); return false; }
  // Bun reports a missing export as a WARNING and still emits `undefined(...)` (the game then fails at load with
  // "not a function"; tsc catches it too, but only if someone runs it). Treat that one as a build failure and show
  // every other warning. Ticket 13, starter/tests/build-warnings.
  // Bun 1.3.11 reports level "warn" at runtime although its types say "warning": accept both.
  const warnings = result.logs.filter((l) => (l.level as string) === "warn" || l.level === "warning");
  for (const l of warnings) console.warn(l);
  if (warnings.some((l) => /will always be undefined/i.test(l.message))) {
    console.error("build failed: an import is used that the module does not export (see the warning above)");
    return false;
  }
  // Bun writes map `sources` relative to outdir, not to the .map file. Entries nest
  // (src/main.js, src/scripts/Spinner.js, ...), so re-base by that depth or every tool
  // that resolves a source against its map ends up too high.
  // Compose with the plugin's edit map first, while sources are still outdir-relative,
  // and only when this build rewrote a file (a fat bundle map is expensive to walk).
  for (const out of result.outputs) {
    if (out.kind !== "sourcemap") continue;
    const map = JSON.parse(readFileSync(out.path, "utf8"));
    const composed = session.maps.size === 0 ? map : composeOutputMap(map, out.path, session);
    const depth = relative(outDir, dirname(out.path)).split("/").filter(Boolean).length;
    if (depth) composed.sources = composed.sources.map((s: string) => "../".repeat(depth) + s);
    writeFileSync(out.path, JSON.stringify(composed));
  }
  // `.js` next to a "type": "module" package.json would be treated as ESM by GodotJS; mark the bundle dir as CommonJS.
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/package.json`, '{"type":"commonjs"}\n');
  for (const out of result.outputs) {
    if (!out.path.endsWith(".js")) continue;
    console.log(`built ${relative(root, out.path)} (${(out.size / 1024).toFixed(0)} KB)`);
  }
  const hint = staleTypingsHint(root); // once per change, not on every save of a watch build (ticket 440)
  if (hint && hint !== lastHint) console.warn(hint);
  lastHint = hint;
  return true;
}
let lastHint: string | null = null;

export async function build(): Promise<boolean> {
  return buildProject(ROOT);
}

let running = false;
let again = false;
async function runBuild() {
  if (running) { again = true; return; }
  running = true;
  try {
    do {
      again = false;
      if (!await build()) process.exitCode = 1;
    } while (again);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    running = false;
  }
}

if (import.meta.main) {
  await runBuild();
  if (process.argv.includes("--watch")) {
    console.log("watching src/ ...");
    // Debounce so a new file is fully written before the rescan. Entrypoints are collected inside build(), so new files count.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void runBuild(); }, 50);
    };
    for (const dir of ["src", "gen"]) {
      const abs = join(ROOT, dir);
      if (existsSync(abs)) watch(abs, { recursive: true }, schedule);
    }
  }
}
