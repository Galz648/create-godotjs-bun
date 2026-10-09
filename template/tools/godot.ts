// Run the configured GodotJS binary (see tools/config.ts) with the given arguments:
//   bun tools/godot.ts --editor --path .
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { requireGodot } from "./config.ts";

// Without a project.godot in the --path folder Godot starts its PROJECT MANAGER, even with --headless: it spins at full CPU
// or waits forever on a modal alert (ticket 390, 30 minutes lost). Refuse with a message instead.
const args = process.argv.slice(2);
const at = args.indexOf("--path");
const projectDir = resolve(at >= 0 && args[at + 1] ? args[at + 1]! : ".");
if (!existsSync(join(projectDir, "project.godot")) && !args.includes("--project-manager")) {
  console.error(`error: no project.godot in ${projectDir}. Godot would open its project manager and never exit. Run this from the game folder or pass --path <game folder>.`);
  process.exit(2);
}

const child = Bun.spawn([requireGodot(), ...args], { stdio: ["inherit", "inherit", "inherit"] });
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.exit(await child.exited);
