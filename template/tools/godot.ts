// Run the configured GodotJS binary (see tools/config.ts) with the given arguments:
//   bun tools/godot.ts --editor --path .
import { requireGodot } from "./config.ts";

const child = Bun.spawn([requireGodot(), ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"] });
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.exit(await child.exited);
