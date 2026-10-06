// Every .ts under src/ is a Bun entrypoint except src/lib/** and *.d.ts (shared code imported by scripts).
// gen/**/*.ts is compiled too: the editor loads those typings as scripts and errors if the JS is missing.
// Output mirrors the res:// path under .godot/GodotJS/ (root: the project directory). godot* stay external (engine-provided).
// tools/plugin rewrites exports, @onready, and connect(fn) before Bun emits. Source maps are composed
// back to the original file only when a file was actually rewritten.
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { composeOutputMap, createSession } from "./plugin/index.ts";

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

export async function buildProject(root: string): Promise<boolean> {
  const session = createSession(root);
  const outDir = join(root, ".godot/GodotJS");
  const result = await Bun.build({
    entrypoints: entrypoints(root),
    outdir: outDir,
    root, // keeps the src/ prefix so the output mirrors the res:// path
    format: "cjs",
    target: "browser", // no node builtins assumed
    external: ["godot", "godot.annotations", "godot-jsb", "jsb.core"],
    minify: process.argv.includes("--minify"),
    sourcemap: process.argv.includes("--minify") ? "none" : "external",
    plugins: [session.plugin],
  });
  if (!result.success) { for (const l of result.logs) console.error(l); return false; }
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
  return true;
}

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
