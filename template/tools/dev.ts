// Rebuild on save and relaunch the game. `bun run dev:build` stays watch-only.
// GODOT_ARGS is split on spaces and appended after `--path .` (tests pass `--headless`; game arguments after a `--`).
// A relaunch starts in the scene that was running (the game's save records it, src/lib/dev-state.ts): `--main-scene` turns
// that off, `--scene res://x.tscn` picks the scene of the first launch (and of a relaunch with no recorded scene).
// State survives a relaunch: before killing the game the runner asks it to save (src/lib/dev-state.ts),
// the next process restores it. `--fresh` (or GODOTJS_DEV_FRESH=1) turns that off. docs/design/dev-state.md.
// Hot reload: when the bundles that changed are script classes the running game can swap in place (src/lib/hot-reload.ts,
// called from src/main.ts), the runner asks the game to reload them and keeps it running. Anything else (an export,
// signal or base class change, a module that throws, no answer) falls back to the relaunch above.
// `--no-hot` (or GODOTJS_DEV_HOT=0) always relaunches. docs/design/hot-reload.md.
// The runner never reports a swap it cannot show: when a changed source file is a plain module (not a script, and not a
// module that registers a class through hot()) the live objects may still run the old code, so it relaunches with state
// and says "plain module changed". The edge cases of that rule are in docs/design/hot-reload.md.
// In a terminal the game's output is piped through tools/unmap.ts (`.js:line:col` to `.ts:line:col`); `--raw` (or
// GODOTJS_DEV_RAW=1) leaves it untouched, and GODOTJS_DEV_UNMAP=1 forces mapping when stdout is not a terminal.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Subprocess } from "bun";
import { build } from "./build.ts";
import { requireGodot } from "./config.ts";
import { translate } from "./unmap.ts";

const ROOT = join(import.meta.dir, "..");

const DEBOUNCE_MS = 150;
const KILL_GRACE_MS = 2000;
const SAVE_ACK_MS = Number(process.env.GODOTJS_DEV_SAVE_ACK_MS) || 1500;
const SAVE_POLL_MS = 25;
const HOT_ACK_MS = Number(process.env.GODOTJS_DEV_HOT_ACK_MS) || 1500;
const hot = !(process.argv.includes("--no-hot") || ["0", "false"].includes(process.env.GODOTJS_DEV_HOT ?? ""));
const OUT_DIR = join(ROOT, ".godot", "GodotJS");
const HOT_REQUEST = join(ROOT, ".godot", "dev-state", "reload-request.json");
const HOT_ACK = join(ROOT, ".godot", "dev-state", "reload-ack.json");
// Old behaviour, ONLY as the negative control of starter/tests/hot-reload: say "swapped" for plain modules and skip the shape probe.
const HOT_UNSAFE = process.env.GODOTJS_HOT_UNSAFE === "1";
const raw = process.argv.includes("--raw") || ["1", "true"].includes(process.env.GODOTJS_DEV_RAW ?? "");
const unmapOutput = !raw && (Boolean(process.stdout.isTTY) || ["1", "true"].includes(process.env.GODOTJS_DEV_UNMAP ?? ""));
let hotCount = 0;
let bundles = new Map<string, { hash: string; mtime: number }>(); // what the running game last loaded
let sources = new Map<string, string>(); // src/** file -> content hash, as of the build the game last loaded

const fresh = process.argv.includes("--fresh") || ["1", "true"].includes(process.env.GODOTJS_DEV_FRESH ?? "");
const STATE_DIR = join(ROOT, ".godot", "dev-state"); // owned by this runner: request, state.json
const STATE_FILE = join(STATE_DIR, "state.json");
const REQUEST_FILE = join(STATE_DIR, "request");
let saveCount = 0;

const godot = requireGodot();
const extraArgs = (process.env.GODOT_ARGS ?? "").split(" ").filter((arg) => arg.length > 0);
const LISTENING_FILE = join(STATE_DIR, "listening"); // written by the game once its dev-state listener runs
const keepScene = !process.argv.includes("--main-scene");
const SCENE_PATH = /^res:\/\/.+\.(tscn|scn)$/;
const startScene = process.argv.includes("--scene") ? (process.argv[process.argv.indexOf("--scene") + 1] ?? "") : "";
if (process.argv.includes("--scene") && !SCENE_PATH.test(startScene)) {
  console.error("error: --scene needs a res:// path to a .tscn or .scn file");
  process.exit(2);
}

/** The project's main scene as a res:// path (project.godot may hold a uid://, which the editor writes; resolved from the .tscn headers). */
function mainScene(): string {
  let main = "";
  try { main = /^run\/main_scene\s*=\s*"([^"]*)"/m.exec(readFileSync(join(ROOT, "project.godot"), "utf8"))?.[1] ?? ""; } catch { return ""; }
  if (!main.startsWith("uid://")) return main;
  for (const rel of new Bun.Glob("**/*.tscn").scanSync({ cwd: ROOT, onlyFiles: true })) {
    if (rel.startsWith(".godot/") || rel.includes("node_modules/")) continue;
    try {
      if (readFileSync(join(ROOT, rel), "utf8").split("\n", 1)[0].includes(`uid="${main}"`)) return `res://${rel}`;
    } catch { /* unreadable: skip */ }
  }
  return main;
}

/** The scene to launch: the one the last save recorded, else --scene; "" means the project's main scene. */
function launchScene(): { scene: string; why: string } {
  let scene = "";
  if (keepScene && !fresh) {
    try { scene = String((JSON.parse(readFileSync(STATE_FILE, "utf8")) as { scene?: unknown }).scene ?? ""); } catch { /* no save */ }
  }
  const why = SCENE_PATH.test(scene) ? "the scene that was running; --main-scene starts at the main scene" : "--scene";
  if (!SCENE_PATH.test(scene)) scene = startScene;
  return { scene: scene === mainScene() ? "" : scene, why };
}

let game: Subprocess | null = null;
let launched = false; // a game was started at least once, so "no game" later means it exited
let stopping = false;
let pending = false;
let running: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function childPids(pid: number): number[] {
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
    return out.trim().split("\n").map((line) => Number(line)).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function descendantPids(pid: number): number[] {
  const kids = childPids(pid);
  return kids.flatMap((child) => [...descendantPids(child), child]);
}

function signalPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

function alive(proc: Subprocess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

async function stopGame(proc: Subprocess): Promise<void> {
  if (!alive(proc)) return;
  const descendants = descendantPids(proc.pid);
  signalPids(descendants, "SIGTERM");
  try { proc.kill("SIGTERM"); } catch { /* already gone */ }
  const force = setTimeout(() => {
    if (!alive(proc)) return;
    signalPids(descendantPids(proc.pid), "SIGKILL");
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }, KILL_GRACE_MS);
  try {
    await proc.exited;
  } finally {
    clearTimeout(force);
  }
}

function clearState(): void {
  rmSync(STATE_FILE, { force: true });
  rmSync(REQUEST_FILE, { force: true });
}

/** Ask the running game to save; true once it answered with this request's token. A hung game just times out. */
async function requestSave(proc: Subprocess): Promise<boolean> {
  const token = `${process.pid}-${++saveCount}-${Date.now()}`;
  writeFileSync(REQUEST_FILE, token);
  const deadline = Date.now() + SAVE_ACK_MS;
  while (Date.now() < deadline && alive(proc)) {
    try {
      if ((JSON.parse(readFileSync(STATE_FILE, "utf8")) as { token?: string }).token === token) return true;
    } catch { /* not written yet, or half written: ask again in a moment */ }
    await Bun.sleep(SAVE_POLL_MS);
  }
  return false;
}

/** Bundle path -> content hash, for every emitted .js. Bun rewrites unchanged outputs too, so compare content. */
function snapshotBundles(): Map<string, { hash: string; mtime: number }> {
  const out = new Map<string, { hash: string; mtime: number }>();
  for (const rel of new Bun.Glob("**/*.js").scanSync(OUT_DIR)) {
    const abs = join(OUT_DIR, rel);
    out.set(rel, { hash: String(Bun.hash(readFileSync(abs))), mtime: Math.floor(statSync(abs).mtimeMs / 1000) });
  }
  return out;
}

/** src/** source file (project-relative) -> content hash. Taken BEFORE a build, so a save during the build counts as changed next time. */
function snapshotSources(): Map<string, string> {
  const out = new Map<string, string>();
  const dir = join(ROOT, "src");
  if (!existsSync(dir)) return out;
  for (const rel of new Bun.Glob("**/*.{ts,tsx,js,mjs,cjs}").scanSync(dir)) {
    if (rel.endsWith(".d.ts")) continue;
    out.set(`src/${rel}`, String(Bun.hash(readFileSync(join(dir, rel)))));
  }
  return out;
}

/** The source files the given bundles were built from (their .js.map `sources`), project-relative; null when a map is missing. */
function bundleSources(rels: string[]): Set<string> | null {
  const out = new Set<string>();
  for (const rel of rels) {
    const map = join(OUT_DIR, `${rel}.map`);
    try {
      for (const src of (JSON.parse(readFileSync(map, "utf8")) as { sources?: string[] }).sources ?? []) {
        out.add(relative(ROOT, resolve(dirname(map), src)).replaceAll("\\", "/"));
      }
    } catch { return null; }
  }
  return out;
}

/** Names this file registers through hot("Name", ...) (src/lib/hot.ts). A text match: the game confirms them in its ack. */
function hotNamesIn(file: string): string[] {
  try {
    const text = readFileSync(join(ROOT, file), "utf8");
    return [...text.matchAll(/\bhot\s*(?:<[^>()]*>)?\(\s*(["'`])([^"'`\n]+)\1\s*,/g)].map((m) => m[2]);
  } catch { return []; }
}

/** Source files that differ between the game's last build and this one. Removed files count. */
function changedSources(now: Map<string, string>): string[] {
  return [...new Set([...sources.keys(), ...now.keys()])].filter((f) => sources.get(f) !== now.get(f));
}

/**
 * The changed source files whose code a swap cannot be shown to reload: plain modules (no script of their own) that
 * went into a changed bundle. Scripts (entries, one bundle each) are swapped by the engine and are not listed.
 */
function changedPlainModules(changedSrc: string[], now: Map<string, string>, allBundles: Map<string, unknown>, changedBundles: string[]): string[] {
  const scripts = new Set([...allBundles.keys()].map((rel) => rel.replace(/\.js$/, ".ts")));
  const inBuild = bundleSources(changedBundles);
  return changedSrc.filter((f) => !scripts.has(f) && (!now.has(f) || inBuild === null || inBuild.has(f)));
}

/**
 * Try to swap the changed scripts into the running game. True when nothing else is needed.
 * The engine only reloads a bundle whose mtime (whole seconds) differs from what it loaded, so two builds in one
 * second would be skipped silently: make every changed bundle's mtime strictly newer than the last one the game saw.
 * `now` is the source snapshot taken before this build started.
 */
async function tryHotReload(prev: Subprocess | null, now: Map<string, string>): Promise<boolean> {
  const next = snapshotBundles();
  const changed = [...next].filter(([rel, b]) => bundles.get(rel)?.hash !== b.hash).map(([rel]) => rel);
  // Hot mode only: the bundles did not change (a comment, a type, a file no script imports), so nothing to do.
  // --no-hot and --fresh keep the old contract, every save relaunches, even when the emitted bytes are identical.
  if (hot && !fresh && changed.length === 0 && prev && alive(prev)) { sources = now; return true; }
  if (!hot || fresh || !prev || !alive(prev)) { bundles = next; sources = now; return false; }
  const changedSrc = changedSources(now);
  const plain = HOT_UNSAFE ? [] : changedPlainModules(changedSrc, now, next, changed);
  const restartFor = (files: string[]): false => {
    console.log(`hot reload: restart needed (plain module changed: ${files.join(", ")})`);
    bundles = next; sources = now;
    return false;
  };
  // A plain module that registers no hot() class: the live objects hold its old classes and functions. Do not swap at all.
  const unbacked = plain.filter((f) => hotNamesIn(f).length === 0);
  if (unbacked.length > 0) return restartFor(unbacked);
  for (const rel of changed) {
    const abs = join(OUT_DIR, rel);
    const t = Math.max(Math.floor(Date.now() / 1000), (bundles.get(rel)?.mtime ?? 0) + 1);
    utimesSync(abs, t, t);
    next.get(rel)!.mtime = t;
  }
  const scripts = changed.filter((rel) => rel.startsWith("src/")).map((rel) => `res://${rel.replace(/\.js$/, ".ts")}`);
  // hot() classes declared in a changed file: the game compares their data shape across the swap.
  const probe = HOT_UNSAFE ? [] : [...new Set(changedSrc.flatMap(hotNamesIn))];
  const token = `${process.pid}-${++hotCount}-${Date.now()}`;
  mkdirSync(join(ROOT, ".godot", "dev-state"), { recursive: true });
  writeFileSync(HOT_REQUEST, JSON.stringify({ token, scripts, probe }));
  const deadline = Date.now() + HOT_ACK_MS;
  while (Date.now() < deadline && alive(prev)) {
    try {
      const ack = JSON.parse(readFileSync(HOT_ACK, "utf8")) as { token?: string; ok?: boolean; hot?: string[]; restart?: string | null; hotNames?: string[] };
      if (ack.token === token) {
        bundles = next; sources = now;
        if (!ack.ok) { console.log(`hot reload: restart needed (${ack.restart})`); return false; }
        // The game confirms which hot() names are registered: a plain module counts as live only through one of them.
        const unconfirmed = plain.filter((f) => !hotNamesIn(f).some((n) => ack.hotNames?.includes(n)));
        if (unconfirmed.length > 0) return restartFor(unconfirmed);
        console.log(`hot reload: swapped ${ack.hot?.length ?? 0} script(s) in the running game`);
        return true;
      }
    } catch { /* not written yet */ }
    await Bun.sleep(SAVE_POLL_MS);
  }
  console.log(`hot reload: no acknowledgement within ${HOT_ACK_MS} ms; restarting`);
  bundles = next; sources = now;
  return false;
}

/** Copy the game's output line by line, mapping bundle positions to the .ts source (tools/unmap.ts). */
async function pump(stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  const emit = (line: string) => out.write(`${translate(line, ROOT)}\n`);
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) emit(line);
  }
  if (buffered) emit(buffered);
}

let pendingSources = new Map<string, string>(); // the source snapshot of the build in flight (or the last one)

async function restartGame(): Promise<void> {
  if (stopping) return;
  const prev = game;
  game = null;
  if (!fresh) {
    mkdirSync(STATE_DIR, { recursive: true });
    if (prev && alive(prev)) {
      if (await requestSave(prev)) console.log("dev-state: saved, relaunching");
      else if (!existsSync(LISTENING_FILE) && existsSync(STATE_FILE)) {
        // The game never started its listener (the script that registers state threw while loading, say): it cannot hold
        // newer state than the save it was launched with, so keep that save for the next launch instead of losing it.
        console.log("dev-state: the game never registered any state (did a script throw while loading?); keeping the last save for the next launch");
      } else {
        console.log(`dev-state: no save acknowledgement within ${SAVE_ACK_MS} ms; relaunching fresh`);
        clearState();
      }
    } else {
      clearState(); // no running game to ask (it crashed or was closed): never restore an older state
      if (prev || launched) console.log("game was not running: starting a new one (no state to restore)");
    }
    rmSync(REQUEST_FILE, { force: true });
  }
  if (prev) await stopGame(prev);
  if (stopping) return;
  rmSync(HOT_REQUEST, { force: true }); rmSync(HOT_ACK, { force: true }); rmSync(LISTENING_FILE, { force: true });
  bundles = snapshotBundles(); // what the new process is about to load
  sources = pendingSources; // ... and the sources it was built from
  const { scene, why } = launchScene();
  if (scene) console.log(`dev: launching ${scene} (${why})`);
  const proc = Bun.spawn({
    cmd: [godot, "--path", ".", ...(scene ? [scene] : []), ...extraArgs],
    cwd: ROOT,
    env: fresh ? process.env : { ...process.env, GODOTJS_DEV_STATE: STATE_DIR },
    stdin: "ignore",
    stdout: unmapOutput ? "pipe" : "inherit",
    stderr: unmapOutput ? "pipe" : "inherit",
  });
  if (unmapOutput) {
    void pump(proc.stdout as ReadableStream<Uint8Array>, process.stdout);
    void pump(proc.stderr as ReadableStream<Uint8Array>, process.stderr);
  }
  game = proc;
  launched = true;
  console.log(`godot started (pid ${proc.pid})`);
  void proc.exited.then(() => {
    if (game === proc) game = null;
  });
}

async function drain(): Promise<void> {
  try {
    while (pending && !stopping) {
      pending = false;
      let ok = false;
      pendingSources = snapshotSources(); // before the build: a save during it is picked up as changed next round
      try {
        ok = await build();
      } catch (err) {
        console.error(err);
      }
      if (stopping) return;
      if (ok) { if (!(await tryHotReload(game, pendingSources))) await restartGame(); }
      else console.error("build failed; leaving the game running");
    }
  } finally {
    running = null;
    if (pending && !stopping) running = drain();
  }
}

function requestBuild(): Promise<void> {
  if (stopping) return Promise.resolve();
  pending = true;
  if (!running) running = drain();
  return running;
}

function isSourceChange(filename: string | null): boolean {
  if (!filename) return true;
  const norm = filename.replaceAll("\\", "/");
  if (norm.endsWith(".d.ts")) return false;
  return /\.(ts|tsx|js|mjs|cjs)$/.test(norm);
}

function schedule(): void {
  if (stopping) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void requestBuild();
  }, DEBOUNCE_MS);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  try {
    if (running) await running;
    const proc = game;
    game = null;
    if (proc) await stopGame(proc);
  } finally {
    process.exit(signal === "SIGINT" ? 130 : 143);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("exit", () => {
  const proc = game;
  if (!proc || !alive(proc)) return;
  signalPids(descendantPids(proc.pid), "SIGKILL");
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
});

if (fresh) console.log("dev-state: off (--fresh)");
else clearState(); // a clean start never restores what an earlier runner left behind
await requestBuild();
console.log("watching src/ ...");
for (const dir of ["src", "gen"]) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  watch(abs, { recursive: true }, (_event, filename) => {
    const name = filename == null ? null : String(filename);
    if (!isSourceChange(name)) return;
    schedule();
  });
}
