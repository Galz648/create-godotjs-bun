#!/usr/bin/env bun
// create-godotjs-bun: scaffold a GodotJS + Bun game project.
//   bunx create-godotjs-bun my-game [--name "My Game"] [--godot /path/to/binary [--save-config]] [--no-effect] [--no-install] [--no-git]
// Hidden: --template <dir> scaffolds from another template dir (the starter/ of a godotjs-esm checkout) instead of the bundled one.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const version = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version as string;
const USAGE = 'usage: bunx create-godotjs-bun <target-dir> [--name "Project Name"] [--godot /path/to/binary [--save-config]] [--no-effect] [--no-install] [--no-git]';

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
const templateFlag = takeFlag("--template");
const templateDir = templateFlag ? resolve(templateFlag) : join(import.meta.dir, "..", "template");
if (!existsSync(join(templateDir, "tools", "toolchain-files.json"))) fail(`${templateDir} is not a template (no tools/toolchain-files.json)`);
const { resolveGodot, cli: configCli } = (await import(join(templateDir, "tools", "config.ts"))) as typeof import("../../../starter/tools/config.ts");
const { stampProject } = (await import(join(templateDir, "tools", "update.ts"))) as typeof import("../../../starter/tools/update.ts");
const saveConfig = takeSwitch("--save-config");
const noEffect = takeSwitch("--no-effect");
const noInstall = takeSwitch("--no-install");
const noGit = takeSwitch("--no-git");
if (argv.length !== 1 || argv[0].startsWith("-") || name === "" || godotFlag === "") fail(USAGE);
if (godotFlag && !existsSync(resolve(godotFlag))) fail(`--godot: ${resolve(godotFlag)} does not exist`);
if (saveConfig && !godotFlag) fail("--save-config needs --godot /path/to/binary");

const target = resolve(argv[0]);
const projectName = name ?? basename(target);
if (!projectName.trim()) fail("the project name is empty");
if (existsSync(target) && (!statSync(target).isDirectory() || readdirSync(target).length > 0)) {
  fail(`refusing to overwrite non-empty or non-directory target ${target}`);
}

// --- copy the template ---
let copied = 0;
// a starter/ checkout (--template) carries what the assembled template leaves out: node_modules, build output, tests, the gap checker
const skip = (rel: string): boolean => /^(node_modules|\.godot|gen|out|tests)(\/|$)/.test(rel) || rel === "tools/check-engine.ts" || rel === ".env" || rel.endsWith(".uid");
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const from = join(dir, entry.name);
    const rel = relative(templateDir, from).split(sep).join("/");
    if (skip(rel)) continue;
    if (entry.isDirectory()) walk(from);
    else if (entry.isFile()) {
      // npm strips .gitignore from packages, so the template stores it as _gitignore
      // game-tests/ in the template is the testing kit's samples: they become the game's own tests/ (the starter's tests/ stay in godotjs-esm)
      const to = join(target, rel === "_gitignore" ? ".gitignore" : rel.startsWith("game-tests/") ? `tests/${rel.slice("game-tests/".length)}` : rel);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      if (rel.startsWith(".githooks/")) chmodSync(to, 0o755);
      copied++;
    }
  }
};
walk(templateDir);

// --- toolchain.json: which version of the toolchain files this project holds (tools/update.ts reads it) ---
stampProject(target, templateDir, version);

// --- --no-effect: overlay the Effect-free demo and drop the dependency (and the lockfile that pins it) ---
if (noEffect) {
  const overlay = join(import.meta.dir, "..", "variants", "no-effect");
  const apply = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const from = join(dir, entry.name);
      if (entry.isDirectory()) apply(from);
      else copyFileSync(from, join(target, relative(overlay, from)));
    }
  };
  apply(overlay);
  // template files that import effect: tsc covers src/lib, so they must not exist without the dependency
  // (the testing kit's Effect samples go too: tools/test-kit.ts itself is Effect-free, tests/effect-support.ts is what imports effect)
  // the game services kit (src/lib/services/*) imports effect: the whole folder goes
  rmSync(join(target, "src/lib/services"), { recursive: true, force: true });
  for (const effectOnly of ["src/lib/game-clock.ts", "src/lib/frame-clock.ts", "src/lib/godot-effect.ts", "src/lib/camp.ts", "tests/effect-support.ts", "tests/logic/camp.test.ts", "tests/engine/effect.test.ts"]) rmSync(join(target, effectOnly), { force: true });
  rmSync(join(target, "bun.lock"), { force: true });
  const tp = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
  delete tp.dependencies?.effect;
  if (tp.dependencies && Object.keys(tp.dependencies).length === 0) delete tp.dependencies;
  writeFileSync(join(target, "package.json"), `${JSON.stringify(tp, null, 2)}\n`);
}

// --- the testing kit: type-check the game's tests with the rest of the project ---
if (existsSync(join(target, "tests"))) {
  const tsPath = join(target, "tsconfig.json");
  const ts = JSON.parse(readFileSync(tsPath, "utf8"));
  if (Array.isArray(ts.include) && !ts.include.includes("tests")) ts.include.push("tests");
  writeFileSync(tsPath, `${JSON.stringify(ts, null, 2)}\n`);
}

// --- name the project ---
const projectPath = join(target, "project.godot");
const quoted = `"${projectName.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
writeFileSync(projectPath, readFileSync(projectPath, "utf8").replace(/^config\/name=.*$/m, () => `config/name=${quoted}`));
const presetPath = join(target, "export_presets.cfg");
if (existsSync(presetPath)) {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "") || "game";
  writeFileSync(presetPath, readFileSync(presetPath, "utf8").replace(/^application\/bundle_identifier=.*$/m, () => `application/bundle_identifier="com.example.${slug}"`));
}
const pkgPath = join(target, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.name = projectName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "godotjs-game";
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(
  join(target, "README.md"),
  `# ${projectName}\n\nA GodotJS + Bun game project, made with [create-godotjs-bun](https://github.com/Galz648/create-godotjs-bun) ${version}.\n\nThe day-to-day loop, layout and gotchas are in [docs/DAILY.md](docs/DAILY.md).\n\n\`\`\`sh\nbun run dev:build   # terminal 1: rebuild on save\nbun run editor      # terminal 2: the Godot editor (F5 to play)\nbun run dev         # or: rebuild and relaunch a game window on every save\nbun run typecheck\nbun run test          # logic tests (bun test, no Godot)\nbun run test:engine   # engine tests (headless Godot)\n\`\`\`\n\nHow to test your game: [docs/DAILY.md, "Testing your game"](docs/DAILY.md#testing-your-game).\n`,
);
console.log(`created ${copied} files in ${target}`);

// --- Godot binary: nothing is written into the project. --godot only reports how to use that binary, or with
// --save-config saves it in the global config (~/.config/godotjs/config.json); otherwise GODOTJS in the shell or the global config apply. ---
const flagged = godotFlag ? resolve(godotFlag) : undefined;
if (flagged && saveConfig) configCli(["set", flagged]);

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

const found = resolveGodot();
const godotLine = flagged && !saveConfig
  ? `Godot binary: ${flagged} was NOT saved. Use it with  export GODOTJS=${flagged}  (this shell only),\n  or save it for every project:  bun tools/config.ts set ${flagged}  (or re-run with --save-config)`
  : found
    ? `Godot binary: ${found.path}  (${found.source})`
    : "Godot binary: NOT configured. Run  bun tools/config.ts set /path/to/godot.macos.editor.universal  inside the project\n  (saves it once for every project), or export GODOTJS=/path/to/binary in the shell";
console.log(`
Created "${projectName}" at ${target}
${godotLine}

Next steps:
  cd ${relative(process.cwd(), target) || "."}
  bun run dev:build   # terminal 1: rebuild on save
  bun run editor      # terminal 2: the Godot editor, then F5 to play  (bun run dev: rebuild + relaunch a game window instead)
  docs/DAILY.md has the day-to-day loop and gotchas
`);
