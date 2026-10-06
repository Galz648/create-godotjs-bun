// Rebuild on save and relaunch the game. `bun run dev:build` stays watch-only.
// GODOT_ARGS is split on spaces and appended after `--path .` (tests pass `--headless`).
// State survives a relaunch: before killing the game the runner asks it to save (src/lib/dev-state.ts),
// the next process restores it. `--fresh` (or GODOTJS_DEV_FRESH=1) turns that off. docs/design/dev-state.md.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { build } from "./build.ts";
import { requireGodot } from "./config.ts";

const ROOT = join(import.meta.dir, "..");

const DEBOUNCE_MS = 150;
const KILL_GRACE_MS = 2000;
const SAVE_ACK_MS = Number(process.env.GODOTJS_DEV_SAVE_ACK_MS) || 1500;
const SAVE_POLL_MS = 25;

const fresh = process.argv.includes("--fresh") || ["1", "true"].includes(process.env.GODOTJS_DEV_FRESH ?? "");
const STATE_DIR = join(ROOT, ".godot", "dev-state"); // owned by this runner: request, state.json
const STATE_FILE = join(STATE_DIR, "state.json");
const REQUEST_FILE = join(STATE_DIR, "request");
let saveCount = 0;

const godot = requireGodot();
const extraArgs = (process.env.GODOT_ARGS ?? "").split(" ").filter((arg) => arg.length > 0);

let game: Subprocess | null = null;
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

async function restartGame(): Promise<void> {
  if (stopping) return;
  const prev = game;
  game = null;
  if (!fresh) {
    mkdirSync(STATE_DIR, { recursive: true });
    if (prev && alive(prev)) {
      if (await requestSave(prev)) console.log("dev-state: saved, relaunching");
      else {
        console.log(`dev-state: no save acknowledgement within ${SAVE_ACK_MS} ms; relaunching fresh`);
        clearState();
      }
    } else {
      clearState(); // no running game to ask (it crashed or was closed): never restore an older state
    }
    rmSync(REQUEST_FILE, { force: true });
  }
  if (prev) await stopGame(prev);
  if (stopping) return;
  const proc = Bun.spawn({
    cmd: [godot, "--path", ".", ...extraArgs],
    cwd: ROOT,
    env: fresh ? process.env : { ...process.env, GODOTJS_DEV_STATE: STATE_DIR },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  game = proc;
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
      try {
        ok = await build();
      } catch (err) {
        console.error(err);
      }
      if (stopping) return;
      if (ok) await restartGame();
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
