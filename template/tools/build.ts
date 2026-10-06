// Every .ts under src/ is a Bun entrypoint except src/lib/** and *.d.ts (shared code imported by scripts).
// gen/**/*.ts is compiled too: the editor loads those typings as scripts and errors if the JS is missing.
// Output mirrors the res:// path under .godot/GodotJS/ (root: the project directory). godot* stay external (engine-provided).
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// Scripts run from the project root; resolve against it anyway so a move into tools/ cannot shift outdir or entrypoints.
const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, ".godot/GodotJS");

function entrypoints(): string[] {
  const files: string[] = [];
  const push = (path: string) => {
    const norm = path.replaceAll("\\", "/").replace(/^\.\//, "");
    if (norm.endsWith(".d.ts")) return;
    if (norm === "src/lib" || norm.startsWith("src/lib/")) return;
    files.push(join(ROOT, norm));
  };
  for (const path of new Bun.Glob("src/**/*.ts").scanSync(ROOT)) push(path);
  for (const path of new Bun.Glob("gen/**/*.ts").scanSync(ROOT)) push(path);
  return files;
}

export async function build(): Promise<boolean> {
  const result = await Bun.build({
    entrypoints: entrypoints(),
    outdir: OUT,
    root: ROOT, // keeps the src/ prefix so the output mirrors the res:// path
    format: "cjs",
    target: "browser", // no node builtins assumed
    external: ["godot", "godot.annotations", "godot-jsb", "jsb.core"],
    minify: process.argv.includes("--minify"),
    sourcemap: process.argv.includes("--minify") ? "none" : "external",
  });
  if (!result.success) { for (const l of result.logs) console.error(l); return false; }
  // Bun writes map `sources` relative to outdir, not to the .map file. Entries nest
  // (src/main.js, src/scripts/Spinner.js, ...), so re-base by that depth or every tool
  // that resolves a source against its map ends up too high.
  for (const out of result.outputs) {
    if (out.kind !== "sourcemap") continue;
    const depth = relative(OUT, dirname(out.path)).split("/").filter(Boolean).length;
    if (!depth) continue;
    const map = JSON.parse(readFileSync(out.path, "utf8"));
    map.sources = map.sources.map((s: string) => "../".repeat(depth) + s);
    writeFileSync(out.path, JSON.stringify(map));
  }
  // `.js` next to a "type": "module" package.json would be treated as ESM by GodotJS; mark the bundle dir as CommonJS.
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/package.json`, '{"type":"commonjs"}\n');
  for (const out of result.outputs) {
    if (!out.path.endsWith(".js")) continue;
    console.log(`built ${relative(ROOT, out.path)} (${(out.size / 1024).toFixed(0)} KB)`);
  }
  return true;
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
