// Where is the GodotJS editor binary? Resolution order, first hit wins:
//   1. GODOTJS in the shell environment, or in this project's .env (Bun loads .env automatically)
//   2. the global config file ~/.config/godotjs/config.json  {"godotjs": "/path/to/binary"}
// Set the global one once with `bun tools/config.ts set <path>`; every project then just works.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const GLOBAL_CONFIG = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "godotjs", "config.json");

export type Resolved = { path: string; source: string };

export function resolveGodot(): Resolved | undefined {
  const env = process.env.GODOTJS;
  if (env) return { path: env, source: "GODOTJS (shell or .env)" };
  try {
    const cfg = JSON.parse(readFileSync(GLOBAL_CONFIG, "utf8")) as { godotjs?: unknown };
    if (typeof cfg.godotjs === "string" && cfg.godotjs) return { path: cfg.godotjs, source: GLOBAL_CONFIG };
  } catch {
    // no global config: fall through
  }
  return undefined;
}

/** The binary path, or print how to configure it and exit non-zero. */
export function requireGodot(): string {
  const found = resolveGodot();
  if (!found) {
    console.error(
      "error: no GodotJS binary configured.\n" +
        "  once, for every project:  bun tools/config.ts set /path/to/godot.macos.editor.universal\n" +
        "  or per project:           put GODOTJS=/path/to/binary in .env (see .env.example)",
    );
    process.exit(1);
  }
  if (!existsSync(found.path)) {
    console.error(`error: the configured GodotJS binary does not exist: ${found.path}\n  (from ${found.source})`);
    process.exit(1);
  }
  return found.path;
}

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function cli(args: string[]): void {
  const [cmd, arg] = args;
  if (cmd === "set" && arg) {
    const path = resolve(arg);
    if (!isExecutableFile(path)) {
      console.error(`error: ${path} is not an executable file`);
      process.exit(1);
    }
    mkdirSync(dirname(GLOBAL_CONFIG), { recursive: true });
    writeFileSync(GLOBAL_CONFIG, `${JSON.stringify({ godotjs: path }, null, 2)}\n`);
    chmodSync(GLOBAL_CONFIG, 0o644);
    console.log(`saved ${path}\n  in ${GLOBAL_CONFIG}`);
  } else if (cmd === "unset") {
    rmSync(GLOBAL_CONFIG, { force: true });
    console.log(`removed ${GLOBAL_CONFIG}`);
  } else if (cmd === "show" || cmd === undefined) {
    const found = resolveGodot();
    if (!found) {
      console.log("no GodotJS binary configured (bun tools/config.ts set <path>, or GODOTJS in .env)");
      process.exit(1);
    }
    console.log(`${found.path}\n  from ${found.source}${existsSync(found.path) ? "" : "\n  WARNING: that file does not exist"}`);
  } else {
    console.error("usage: bun tools/config.ts [show | set <path> | unset]");
    process.exit(1);
  }
}

if (import.meta.main) cli(process.argv.slice(2));
