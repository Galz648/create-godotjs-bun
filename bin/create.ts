#!/usr/bin/env bun
// create-godotjs-bun: scaffold a GodotJS + Bun game project.
//   bunx create-godotjs-bun my-game [--name "My Game"] [--godot /path/to/binary] [--no-install] [--no-git]
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { resolveGodot } from "../template/tools/config.ts";

const templateDir = join(import.meta.dir, "..", "template");
const version = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version as string;
const USAGE = 'usage: bunx create-godotjs-bun <target-dir> [--name "Project Name"] [--godot /path/to/binary] [--no-install] [--no-git]';

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function run(command: string, args: string[], cwd: string): void {
  const r = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (r.error || r.status !== 0) fail(`${command} ${args.join(" ")} failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}`);
}

// --- args ---
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (argv.includes("--version") || argv.includes("-v")) {
  console.log(version);
  process.exit(0);
}
const takeFlag = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const takeSwitch = (flag: string): boolean => {
  const i = argv.indexOf(flag);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};
const name = takeFlag("--name");
const godotFlag = takeFlag("--godot");
const noInstall = takeSwitch("--no-install");
const noGit = takeSwitch("--no-git");
if (argv.length !== 1 || argv[0].startsWith("-") || name === "" || godotFlag === "") fail(USAGE);
if (godotFlag && !existsSync(resolve(godotFlag))) fail(`--godot: ${resolve(godotFlag)} does not exist`);

const target = resolve(argv[0]);
const projectName = name ?? basename(target);
if (!projectName.trim()) fail("the project name is empty");
if (existsSync(target) && (!statSync(target).isDirectory() || readdirSync(target).length > 0)) {
  fail(`refusing to overwrite non-empty or non-directory target ${target}`);
}

// --- copy the template ---
let copied = 0;
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const from = join(dir, entry.name);
    const rel = relative(templateDir, from).split(sep).join("/");
    if (entry.isDirectory()) walk(from);
    else if (entry.isFile()) {
      // npm strips .gitignore from packages, so the template stores it as _gitignore
      const to = join(target, rel === "_gitignore" ? ".gitignore" : rel);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      if (rel.startsWith(".githooks/")) chmodSync(to, 0o755);
      copied++;
    }
  }
};
walk(templateDir);

// --- name the project ---
const projectPath = join(target, "project.godot");
const quoted = `"${projectName.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
writeFileSync(projectPath, readFileSync(projectPath, "utf8").replace(/^config\/name=.*$/m, () => `config/name=${quoted}`));
const pkgPath = join(target, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.name = projectName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "godotjs-game";
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(
  join(target, "README.md"),
  `# ${projectName}\n\nA GodotJS + Bun game project, made with [create-godotjs-bun](https://github.com/Galz648/create-godotjs-bun) ${version}.\n\nThe day-to-day loop, layout and gotchas are in [docs/DAILY.md](docs/DAILY.md).\n\n\`\`\`sh\nbun run dev:build   # terminal 1: rebuild on save\nbun run editor      # terminal 2: the Godot editor (F5 to play)\nbun run dev         # or: rebuild and relaunch a game window on every save\nbun run typecheck\n\`\`\`\n`,
);
console.log(`created ${copied} files in ${target}`);

// --- Godot binary: --godot wins; a binary from the shell env is remembered in this project's .env;
// the global config (~/.config/godotjs/config.json) needs nothing, projects inherit it. ---
const found = godotFlag ? { path: resolve(godotFlag), source: "--godot" } : resolveGodot();
if (found && (found.source === "--godot" || found.source.startsWith("GODOTJS"))) {
  writeFileSync(join(target, ".env"), `GODOTJS=${found.path}\n`);
}

// --- install, build, git ---
if (!noInstall) {
  run("bun", ["install"], target);
  run("bun", ["run", "build"], target);
}
if (!noGit) {
  // Not inside a git repo yet: start one and enable the type-check pre-commit hook. Never fatal.
  const inRepo = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: target, stdio: "ignore" }).status === 0;
  if (!inRepo) {
    const init = spawnSync("git", ["init", "-q"], { cwd: target, stdio: "ignore" });
    if (init.status === 0) spawnSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: target, stdio: "ignore" });
    else console.warn("note: could not run git init; skipped (use --no-git to silence)");
  }
}

const godotLine = found
  ? `Godot binary: ${found.path}  (${found.source})`
  : "Godot binary: NOT configured. Run  bun tools/config.ts set /path/to/godot.macos.editor.universal  inside the project\n  (saves it once for every project), or put GODOTJS=/path/to/binary in .env";
console.log(`
Created "${projectName}" at ${target}
${godotLine}

Next steps:
  cd ${relative(process.cwd(), target) || "."}
  bun run dev:build   # terminal 1: rebuild on save
  bun run editor      # terminal 2: the Godot editor, then F5 to play  (bun run dev: rebuild + relaunch a game window instead)
  docs/DAILY.md has the day-to-day loop and gotchas
`);
