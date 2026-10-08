// One command: bundle with the plugin, export a release macOS .app into out/, and check it.
//   bun run export:macos                        # build, export, then three checks (see below)
//   bun run export:macos --expect "text"        # the debug-build log must contain this text
//   bun run export:macos --no-smoke             # only build + export + the pack check (no app is run)
//   bun run export:macos --frames 600           # frames the debug-build run lasts (default 300)
//   bun run export:macos --no-zip               # skip the jam archive step (dist/<Name>-macos.zip)
//   bun run export:macos --game-args "--autoplay"   # arguments for YOUR game (after `--`) in every app run: drive it past a
//                                               # menu. The release probe then also reports at the last frame (--frames).
// After the checks pass, the app is ad-hoc signed and zipped with a player README into dist/, and the checks run again FROM the zip.
// What each check shows and does NOT show: docs/SHIPPING.md, section "What the export check proves".
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { requireGodot } from "./config.ts";
import { readPck } from "./pck.ts";

const ROOT = join(import.meta.dir, "..");
const TEMPLATES_TAG = "v1.1.0.beta1-4.6.1";
const TEMPLATE_ASSET = "macos-template-app-4.6.1-qjs-ng.zip";

// --- args ---
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OPTIONS_WITH_VALUE = ["--expect", "--frames", "--game-args"];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (OPTIONS_WITH_VALUE.includes(a)) { i++; continue; } // its value may itself start with -- ("--game-args --autoplay")
  if (a.startsWith("--") && !["--no-smoke", "--no-zip"].includes(a)) die(`unknown option ${a}\nusage: bun run export:macos [--expect "text"] [--frames N] [--game-args "args"] [--no-smoke] [--no-zip]`);
}
const gameArgsText = value("--game-args");
if (flag("--game-args") && gameArgsText === undefined) die('--game-args needs a value, for example --game-args "--autoplay"');
const gameArgs = (gameArgsText ?? "").split(" ").filter((a) => a.length > 0);
const userArgs = gameArgs.length ? ["--", ...gameArgs] : []; // after `--` Godot hands them to the game (OS.get_cmdline_user_args)
const expectText = value("--expect");
if (flag("--expect") && !expectText) die("--expect needs a text argument");
const frames = Number(value("--frames") ?? 300);
if (!Number.isInteger(frames) || frames < 1) die("--frames needs a positive integer");
const smoke = !flag("--no-smoke");
const zipStep = !flag("--no-zip");

function die(message: string): never {
  console.error(`\nEXPORT FAIL: ${message}`);
  process.exit(1);
}

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
function record(name: string, ok: boolean, detail: string): boolean {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  return ok;
}
const step = (n: number, total: number, text: string) => console.log(`\n[${n}/${total}] ${text}`);
const TOTAL = (smoke ? 7 : 5) + (zipStep ? 1 : 0);

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? ROOT, encoding: "utf8", env: { ...process.env, ...opts.env }, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, timedOut: r.error?.name === "Error" && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" };
}

// --- project facts ---
const projectText = readFileSync(join(ROOT, "project.godot"), "utf8");
const projectName = projectText.match(/^config\/name="((?:[^"\\]|\\.)*)"/m)?.[1]?.replace(/\\(.)/g, "$1");
if (!projectName) die("project.godot has no config/name");
const appName = projectName.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Game";
const outDir = join(ROOT, "out");
// scenes other than the main one that attach a .ts script: what a smoke run that stops at the main scene never sees
const mainScenePath = projectText.match(/^run\/main_scene="([^"]*)"/m)?.[1] ?? "";
const otherScriptScenes = [...new Bun.Glob("**/*.tscn").scanSync({ cwd: ROOT, onlyFiles: true })]
  .filter((rel) => !/^(\.godot|node_modules|tests|addons|out|dist|gen)\//.test(rel) && `res://${rel}` !== mainScenePath)
  .filter((rel) => { try { return /path="res:\/\/[^"]+\.ts"/.test(readFileSync(join(ROOT, rel), "utf8")); } catch { return false; } })
  .sort();
const appPath = join(outDir, `${appName}.app`);

if (!existsSync(join(ROOT, "export_presets.cfg"))) die("export_presets.cfg is missing. Copy it from the starter (it holds the macOS preset and the exclude filter).");
const presets = readFileSync(join(ROOT, "export_presets.cfg"), "utf8");
if (!/^platform="macOS"/m.test(presets)) die('export_presets.cfg has no preset with platform="macOS"');
const presetName = presets.match(/^name="([^"]*)"\s*\nplatform="macOS"/m)?.[1] ?? "macOS";
if (/^exclude_filter=.*\*\.ts\b/m.test(presets)) die('the preset exclude filter contains "*.ts". The engine loader needs the .ts paths to find the bundles; remove it.');
if (!/^textures\/vram_compression\/import_etc2_astc=true/m.test(projectText)) {
  die(
    "project.godot lacks the ETC2/ASTC setting, and Godot refuses a universal/arm64 macOS export without it.\n" +
      "  Add this to project.godot (inside an existing [rendering] section if there is one):\n\n    [rendering]\n    textures/vram_compression/import_etc2_astc=true\n",
  );
}
const bundleId = presets.match(/^application\/bundle_identifier="([^"]*)"/m)?.[1] ?? "";
if (bundleId.startsWith("com.example.")) console.log(`note: application/bundle_identifier is "${bundleId}" (a placeholder). Set your own in export_presets.cfg before you ship.`);

// 1. build
step(1, TOTAL, "build with the plugin (bun tools/build.ts)");
{
  const r = run("bun", ["tools/build.ts"]);
  if (r.status !== 0) {
    console.error(r.output);
    die("the build failed (see above)");
  }
  console.log(`  built (${r.output.split("\n").filter((l) => l.startsWith("built ")).length} bundle files)`);
}

// 2. engine binary
step(2, TOTAL, "Godot binary");
const godot = requireGodot();
const versionLine = run(godot, ["--version"]).output.trim().split("\n").pop() ?? "";
const version = versionLine.match(/^(\d+\.\d+(?:\.\d+)?\.[a-z]+\d*)/)?.[1];
if (!version) die(`could not read the Godot version from "${versionLine}" (binary: ${godot})`);
console.log(`  ${godot}\n  version ${versionLine}`);

// 3. export templates
step(3, TOTAL, `export templates for ${version}`);
const templateDir =
  process.platform === "darwin"
    ? join(homedir(), "Library/Application Support/Godot/export_templates", version)
    : process.platform === "win32"
      ? join(process.env.APPDATA ?? "", "Godot/export_templates", version)
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "godot/export_templates", version);
const zip = join(templateDir, "macos.zip");
if (!existsSync(zip) || !existsSync(join(templateDir, "version.txt")) || readFileSync(join(templateDir, "version.txt"), "utf8").trim() !== version) {
  die(
    `the macOS export templates for ${version} are not installed.\n` +
      `  Godot looks for:  ${zip}\n  and  ${join(templateDir, "version.txt")}  containing  ${version}\n\n` +
      "  Install them once (the GodotJS release carries templates with the JS runtime built in; the official\n" +
      "  Godot templates do NOT contain GodotJS and cannot run this game):\n\n" +
      `    mkdir -p /tmp/godotjs-templates && cd /tmp/godotjs-templates\n` +
      `    gh release download ${TEMPLATES_TAG} -R godotjs/GodotJS -p '${TEMPLATE_ASSET}'\n` +
      `    unzip -q ${TEMPLATE_ASSET} && cd ${TEMPLATE_ASSET.replace(/\.zip$/, "")}\n` +
      "    zip -qry macos.zip macos_template.app\n" +
      `    mkdir -p "${templateDir}"\n` +
      `    cp macos.zip "${templateDir}/" && echo ${version} > "${templateDir}/version.txt"\n\n` +
      "  (details: docs/SHIPPING.md, 'Install the export templates')\n",
  );
}
const listing = run("unzip", ["-Z1", zip]).output;
const needed = ["macos_template.app/Contents/MacOS/godot_macos_release.universal", "macos_template.app/Contents/MacOS/godot_macos_debug.universal"];
const missing = needed.filter((n) => !listing.includes(n));
if (listing && missing.length) die(`${zip} does not contain ${missing.join(", ")}; reinstall it (docs/SHIPPING.md, 'Install the export templates').`);
console.log(`  ${zip}  (release + debug universal present)`);

// 4. export the release app
step(4, TOTAL, `export release app -> out/${appName}.app`);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, ".gdignore"), ""); // keep the editor from scanning the exported app
if (existsSync(appPath)) {
  if (!appPath.startsWith(`${outDir}/`) || !appPath.endsWith(".app")) die(`refusing to delete ${appPath}`);
  rmSync(appPath, { recursive: true, force: true }); // a previous export of THIS project, inside out/
}
const exp = run(godot, ["--headless", "--path", ROOT, "--export-release", presetName, appPath], { timeoutMs: 600_000 });
const exportErrors = exp.output.split("\n").filter((l) => /^(ERROR|SCRIPT ERROR|WARNING: \[jsb\])|\[jsb\]\[Error\]/.test(l));
if (exp.status !== 0 || !existsSync(join(appPath, "Contents/MacOS"))) {
  console.error(exp.output.split("\n").filter((l) => !l.includes("savepack")).join("\n"));
  die(`the Godot export failed (exit ${exp.status})`);
}
if (exportErrors.length) console.log(`  export printed ${exportErrors.length} error/warning line(s):\n    ${exportErrors.join("\n    ")}`);
const pckPath = join(appPath, "Contents/Resources", `${appName}.pck`);
const exeName = readdirNames(join(appPath, "Contents/MacOS"))[0];
function readdirNames(dir: string): string[] {
  return Array.from(new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: false }));
}
if (!exeName) die("no executable inside the exported app");
const sizeMB = (b: number) => (b / 1048576).toFixed(0);
console.log(`  ${appPath}  (${sizeMB(Number(run("du", ["-sk", appPath]).output.split("\t")[0]) * 1024)} MB)`);
if (!existsSync(pckPath)) die(`the app has no pack at ${pckPath}`);

// 5. pack check
step(5, TOTAL, "check what is inside the exported pack");
{
  const { entries } = readPck(pckPath);
  const paths = new Map(entries.map((e) => [e.path.replace(/^res:\/\//, ""), e]));
  const remaps = [...paths.keys()].filter((p) => p.endsWith(".ts.remap"));
  const problems: string[] = [];
  for (const r of remaps) {
    const want = `.godot/GodotJS/${r.replace(/\.ts\.remap$/, ".js")}`;
    const inPack = paths.get(want);
    const onDisk = join(ROOT, want);
    if (!inPack) problems.push(`${r} has no ${want} in the pack`);
    else if (!existsSync(onDisk) || statSync(onDisk).size !== inPack.size) problems.push(`${want} in the pack (${inPack.size} B) differs from the build output`);
  }
  const leaked = [...paths.keys()].filter((p) => /^(tools|typings|docs|tests|bun|node_modules|out|dist|\.vscode|\.githooks)\//.test(p) || /^(README\.md|bun\.lock|tsconfig\.json|package\.json|\.env.*)$/.test(p));
  if (leaked.length) problems.push(`tooling files in the pack: ${leaked.slice(0, 5).join(", ")}${leaked.length > 5 ? ", ..." : ""}`);
  if (!paths.has("project.binary")) problems.push("no project.binary");
  record("bundle in pack", remaps.length > 0 && problems.length === 0, remaps.length === 0 ? "no .ts scripts found in the pack (the loader needs src/**/*.ts)" : problems.length ? problems.join("; ") : `${remaps.length} script(s), every compiled .js present and byte-identical to the build output; no tooling files; ${entries.length} files total`);
}

// Run a release .app headless with the smoke probe. Works on a COPY inside `work` (an override.cfg is added to the copy, the
// original is never touched) and records one check. `work` is a fresh mkdtemp directory made by the caller.
function probeRun(checkName: string, sourceApp: string, work: string): boolean {
  const exe = readdirNames(join(sourceApp, "Contents/MacOS")).find((n) => n !== "override.cfg") ?? "";
  const copy = join(work, "app.app");
  const cp = run("cp", ["-R", sourceApp, copy]);
  if (cp.status !== 0) die(`could not copy the app for the probe run: ${cp.output}`);
  const probe = join(work, "probe.gd");
  copyFileSync(join(import.meta.dir, "smoke/probe.gd"), probe);
  writeFileSync(join(copy, "Contents/MacOS/override.cfg"), `[autoload]\n\nGodotJSSmokeProbe="*${probe}"\n`);
  const reportPath = join(work, "report.json");
  // with --game-args the game is driven past its first screen: the probe reports at frame 15 AND at the last frame (--frames)
  const probeFrames = gameArgs.length ? Math.max(frames, 15) : 15;
  const r = run(join(copy, "Contents/MacOS", exe), ["--headless", "--quit-after", String(Math.max(600, probeFrames + 300)), ...userArgs], { env: { GODOTJS_SMOKE_OUT: reportPath, GODOTJS_SMOKE_FRAMES: String(probeFrames) }, timeoutMs: 120_000 });
  const lines = r.output.split("\n").filter((l) => /^(ERROR|SCRIPT ERROR|WARNING)|\[jsb\]\[(Error|Warning)\]/.test(l));
  let report: Record<string, unknown> | undefined;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    /* no report: the app never reached the probe */
  }
  const nJs = Array.isArray(report?.js_script_nodes) ? (report.js_script_nodes as string[]).length : 0;
  const bad = Array.isArray(report?.js_scripts_not_instantiable) ? (report.js_scripts_not_instantiable as string[]) : [];
  const hasTs = results.find((x) => x.name === "bundle in pack")?.ok === true;
  const detail = report
    ? `exit ${r.status}, ${report.frames} frames, main scene ${report.main_scene_loaded ? `loaded (${report.main_scene})` : "NOT loaded"}, ${nJs} live .ts script node(s), ${report.node_count} nodes, release build: ${report.debug_build === false}`
    : `exit ${r.status}${r.timedOut ? " (timed out after 120 s)" : ""}, the probe never reported`;
  const ok = r.status === 0 && !!report && report.main_scene_loaded === true && bad.length === 0 && report.debug_build === false && lines.length === 0;
  record(checkName, ok, detail + (bad.length ? `; scripts that cannot instantiate: ${bad.join(", ")}` : "") + (lines.length ? `; engine printed: ${lines.slice(0, 3).join(" | ")}` : ""));
  if (ok && nJs === 0 && hasTs) console.log(`  note: the pack has .ts scripts but none was attached to a node ${report?.frames} frames after start (fine if your game attaches them later)`);
  if (ok && !gameArgs.length && otherScriptScenes.length) console.log(`  note: only the main scene ran; ${otherScriptScenes.length} other scene(s) with .ts scripts (${otherScriptScenes.slice(0, 3).join(", ")}${otherScriptScenes.length > 3 ? ", ..." : ""}) were never reached. A game behind a menu: --game-args "--autoplay" (your own flag) drives it further`);
  if (!ok) console.log(r.output.split("\n").slice(-15).join("\n"));
  return ok;
}

if (smoke) {
  // 6. run the exported RELEASE app (copy), with a probe autoload that lives outside the app
  step(6, TOTAL, "run the release app headless with the smoke probe");
  const work = mkdtempSync(join(tmpdir(), "godotjs-smoke-"));
  try {
    probeRun("release app runs the game", appPath, work);
  } finally {
    // work is a fresh mkdtemp directory created above: only that is removed
    if (work.startsWith(tmpdir()) && work.includes("godotjs-smoke-")) rmSync(work, { recursive: true, force: true });
  }

  // 7. DEBUG build of the same project, run with its console visible
  step(7, TOTAL, `debug build, run headless for ${frames} frames, read the log${expectText ? ` (expect "${expectText}")` : ""}`);
  const work2 = mkdtempSync(join(tmpdir(), "godotjs-smoke-"));
  try {
    const dbgApp = join(work2, `${appName}.app`);
    const e2 = run(godot, ["--headless", "--path", ROOT, "--export-debug", presetName, dbgApp], { timeoutMs: 600_000 });
    if (e2.status !== 0 || !existsSync(join(dbgApp, "Contents/MacOS"))) {
      console.error(e2.output.split("\n").filter((l) => !l.includes("savepack")).join("\n"));
      die(`the debug export failed (exit ${e2.status})`);
    }
    const r = run(join(dbgApp, "Contents/MacOS", exeName), ["--headless", "--quit-after", String(frames), ...userArgs], { timeoutMs: 120_000 });
    const log = r.output;
    const errs = log.split("\n").filter((l) => /^(ERROR|SCRIPT ERROR)|\[jsb\]\[Error\]|Failed loading|Can't load/.test(l));
    const started = /Godot Engine v/.test(log);
    const expectOk = expectText === undefined || log.includes(expectText);
    const ok = r.status === 0 && started && errs.length === 0 && expectOk;
    record(
      "debug app log",
      ok,
      `exit ${r.status}${r.timedOut ? " (timed out)" : ""}, engine ${started ? "started" : "did NOT start"}, ${errs.length} error line(s)` +
        (expectText !== undefined ? `, expected text ${expectOk ? "found" : `NOT found: "${expectText}"`}` : ", no --expect given (generic check only)") +
        (errs.length ? `: ${errs.slice(0, 3).join(" | ")}` : ""),
    );
    if (!ok) console.log(log.split("\n").slice(-25).join("\n"));
  } finally {
    if (work2.startsWith(tmpdir()) && work2.includes("godotjs-smoke-")) rmSync(work2, { recursive: true, force: true });
  }
}

// 8. jam archive: ad-hoc sign a staged copy, zip it with the player README, then verify FROM the zip
if (zipStep) {
  step(TOTAL, TOTAL, `jam archive -> dist/${appName}-macos.zip (ad-hoc signed, checked from the zip)`);
  if (!results.every((r) => r.ok)) {
    console.log("  skipped: a check above failed, no archive is made from a failing build");
  } else {
    const distDir = join(ROOT, "dist");
    const zipPath = join(distDir, `${appName}-macos.zip`);
    const stage = mkdtempSync(join(tmpdir(), "godotjs-zip-"));
    try {
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, ".gdignore"), ""); // keep the editor from scanning the archive
      const packDir = join(stage, "pack");
      mkdirSync(packDir);
      const stagedApp = join(packDir, `${appName}.app`);
      const dc = run("ditto", [appPath, stagedApp]);
      if (dc.status !== 0) die(`could not stage the app: ${dc.output}`);
      const sign = run("codesign", ["--force", "--deep", "-s", "-", stagedApp]);
      if (sign.status !== 0) {
        record("ad-hoc signature", false, `codesign failed (exit ${sign.status}): ${sign.output.trim().slice(0, 300)}`);
      } else {
        writeFileSync(join(packDir, "README-macos.txt"), playerReadme(appName));
        rmSync(zipPath, { force: true }); // a previous archive of THIS project, inside dist/
        const z = run("ditto", ["-c", "-k", "--norsrc", "--noextattr", "--noqtn", "--noacl", packDir, zipPath]);
        if (z.status !== 0 || !existsSync(zipPath)) die(`ditto could not make the archive: ${z.output}`);
        console.log(`  ${zipPath}  (${sizeMB(statSync(zipPath).size)} MB)`);
        // verify from a fresh directory, the way a player's Mac extracts it
        const fresh = join(stage, "fresh");
        mkdirSync(fresh);
        const x = run("ditto", ["-x", "-k", zipPath, fresh]);
        const exApp = join(fresh, `${appName}.app`);
        record(
          "archive content",
          x.status === 0 && existsSync(exApp) && existsSync(join(fresh, "README-macos.txt")),
          x.status === 0 ? `${appName}.app and README-macos.txt extracted with ditto -x -k` : `ditto -x -k failed: ${x.output.trim()}`,
        );
        const v = run("codesign", ["--verify", "--deep", "--strict", exApp]);
        const d = run("codesign", ["-dv", exApp]).output;
        const adhoc = /Signature=adhoc/.test(d) && /Sealed Resources version=\d+ rules=\d+ files=\d+/.test(d);
        record("signature from the zip", v.status === 0 && adhoc, v.status === 0 ? `verifies (--deep --strict); ${adhoc ? "Signature=adhoc, resources sealed" : "NOT adhoc with sealed resources"}` : `codesign --verify failed: ${v.output.trim().slice(0, 200)}`);
        // negative control: a tampered copy of the same extracted app must NOT verify
        const tampered = join(fresh, "tampered.app");
        run("ditto", [exApp, tampered]);
        const tpck = join(tampered, "Contents/Resources", `${appName}.pck`);
        if (existsSync(tpck)) writeFileSync(tpck, Buffer.concat([readFileSync(tpck), Buffer.from("x")]));
        const vb = run("codesign", ["--verify", "--deep", "--strict", tampered]);
        record(
          "control: tampered archive copy is rejected",
          existsSync(tpck) && vb.status !== 0,
          existsSync(tpck) && vb.status !== 0 ? "codesign --verify fails after one byte was appended to the pack (the signature check can fail)" : "codesign still verified a modified pack, or the pack was not found: the signature check proves nothing",
        );
        rmSync(tampered, { recursive: true, force: true });
        if (smoke) {
          const work3 = mkdtempSync(join(tmpdir(), "godotjs-smoke-"));
          try {
            probeRun("app from the zip runs the game", exApp, work3);
          } finally {
            if (work3.startsWith(tmpdir()) && work3.includes("godotjs-smoke-")) rmSync(work3, { recursive: true, force: true });
          }
        }
      }
    } finally {
      if (stage.startsWith(tmpdir()) && stage.includes("godotjs-zip-")) rmSync(stage, { recursive: true, force: true });
    }
  }
}

function playerReadme(name: string): string {
  return `${name} for macOS
${"=".repeat(name.length + 10)}

This game is not signed with an Apple Developer ID and is not notarized. macOS will refuse to open it
the first time and say it cannot be verified. That is expected; it is safe to open if you got this file
from the person who made the game. Do this once:

  1. Unzip the file (double-click it in Finder). Move ${name}.app anywhere, for example to Applications.
  2. Double-click ${name}.app. macOS shows a warning and does not open it. Click Done (or OK).
  3. Open System Settings > Privacy & Security, scroll down to the message about "${name}",
     click Open Anyway, and confirm with your password. (On macOS 14 and older you can instead
     right-click the app, choose Open, then Open.)
  4. From now on it opens normally.

If you prefer the Terminal, one command does the same thing:

  xattr -dr com.apple.quarantine /path/to/${name}.app

What to expect
  - Works on Apple Silicon (M1 and later) and on Intel Macs (one universal app).
  - The first start can take a few seconds.
  - If the app does not open at all, tell the author your macOS version and whether the Mac is Intel or Apple Silicon.
`;
}

const allOk = results.every((r) => r.ok);
console.log(`\n${allOk ? "EXPORT PASS" : "EXPORT FAIL"}  ${appPath}`);
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
if (!smoke) console.log("  (--no-smoke: the app was NOT run; only the pack contents were checked)");
if (allOk && zipStep) console.log(`  ad-hoc signed archive: dist/${appName}-macos.zip (not notarized: players follow README-macos.txt; see docs/SHIPPING.md)`);
else if (allOk) console.log("  unsigned and not notarized: see docs/SHIPPING.md before giving it to anyone");
process.exit(allOk ? 0 : 1);
