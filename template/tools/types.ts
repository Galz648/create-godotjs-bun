// `bun run types` generates Godot API typings, then parks the minimal shim so it does not
// merge with them. `bun run types:shim` puts the shim back and deletes the generated files.
import { spawnSync } from "node:child_process";
import { requireGodot } from "./config.ts";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const typings = join(root, "typings");
const shim = join(typings, "godot.d.ts");
const parked = join(typings, "godot.shim.d.ts.off");
const keep = new Set([".gdignore", "godot.d.ts", "godot.shim.d.ts.off", "godot-extras.d.ts"]);

function isShim(path: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").includes("Minimal typings so");
}

function removeGenerated(): void {
  if (!existsSync(typings)) return;
  for (const name of readdirSync(typings)) {
    if (keep.has(name)) continue;
    rmSync(join(typings, name), { recursive: true, force: true });
  }
}

function ensureGdignore(): void {
  const path = join(typings, ".gdignore");
  if (!existsSync(path)) writeFileSync(path, "");
}

function parkShim(): void {
  if (!isShim(shim)) {
    if (!existsSync(shim) && existsSync(parked)) console.log("shim already parked at typings/godot.shim.d.ts.off");
    return;
  }
  if (existsSync(parked)) rmSync(parked);
  renameSync(shim, parked);
  console.log("parked typings/godot.d.ts -> typings/godot.shim.d.ts.off");
}

function restoreShim(): void {
  removeGenerated();
  if (existsSync(parked)) {
    if (existsSync(shim)) rmSync(shim);
    renameSync(parked, shim);
  }
  if (!existsSync(shim)) {
    console.error("error: typings/godot.d.ts shim is missing and typings/godot.shim.d.ts.off is missing");
    process.exit(1);
  }
  console.log("restored typings/godot.d.ts shim");
  ensureGdignore();
}

if (process.argv.includes("--shim")) {
  restoreShim();
  process.exit(0);
}

const godot = requireGodot();

const result = spawnSync(
  godot,
  ["--headless", "--editor", "--generate-types", "--quit-after", "3000", "--path", "."],
  { cwd: root, stdio: "inherit" },
);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

parkShim();
ensureGdignore();
