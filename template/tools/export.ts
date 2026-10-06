// One command: bundle with the plugin, export a release macOS .app into out/, and check it.
//   bun run export:macos                        # build, export, then three checks (see below)
//   bun run export:macos --expect "text"        # the debug-build log must contain this text
//   bun run export:macos --no-smoke             # only build + export + the pack check (no app is run)
//   bun run export:macos --frames 600           # frames the debug-build run lasts (default 300)
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
for (const a of argv) if (a.startsWith("--") && !["--expect", "--frames", "--no-smoke"].includes(a)) die(`unknown option ${a}\nusage: bun run export:macos [--expect "text"] [--frames N] [--no-smoke]`);
const expectText = value("--expect");
if (flag("--expect") && !expectText) die("--expect needs a text argument");
const frames = Number(value("--frames") ?? 300);
if (!Number.isInteger(frames) || frames < 1) die("--frames needs a positive integer");
const smoke = !flag("--no-smoke");

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
const TOTAL = smoke ? 7 : 5;

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
  const leaked = [...paths.keys()].filter((p) => /^(tools|typings|docs|tests|bun|node_modules|out|\.vscode|\.githooks)\//.test(p) || /^(README\.md|bun\.lock|tsconfig\.json|package\.json|\.env.*)$/.test(p));
  if (leaked.length) problems.push(`tooling files in the pack: ${leaked.slice(0, 5).join(", ")}${leaked.length > 5 ? ", ..." : ""}`);
  if (!paths.has("project.binary")) problems.push("no project.binary");
  record("bundle in pack", remaps.length > 0 && problems.length === 0, remaps.length === 0 ? "no .ts scripts found in the pack (the loader needs src/**/*.ts)" : problems.length ? problems.join("; ") : `${remaps.length} script(s), every compiled .js present and byte-identical to the build output; no tooling files; ${entries.length} files total`);
}

if (smoke) {
  // 6. run the exported RELEASE app (copy), with a probe autoload that lives outside the app
  step(6, TOTAL, "run the release app headless with the smoke probe");
  const work = mkdtempSync(join(tmpdir(), "godotjs-smoke-"));
  try {
    const copy = join(work, "app.app");
    const cp = run("cp", ["-R", appPath, copy]);
    if (cp.status !== 0) die(`could not copy the app for the probe run: ${cp.output}`);
    const probe = join(work, "probe.gd");
    copyFileSync(join(import.meta.dir, "smoke/probe.gd"), probe);
    writeFileSync(join(copy, "Contents/MacOS/override.cfg"), `[autoload]\n\nGodotJSSmokeProbe="*${probe}"\n`);
    const reportPath = join(work, "report.json");
    const r = run(join(copy, "Contents/MacOS", exeName), ["--headless", "--quit-after", "600"], { env: { GODOTJS_SMOKE_OUT: reportPath }, timeoutMs: 60_000 });
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
      : `exit ${r.status}${r.timedOut ? " (timed out after 60 s)" : ""}, the probe never reported`;
    const ok = r.status === 0 && !!report && report.main_scene_loaded === true && bad.length === 0 && report.debug_build === false && lines.length === 0;
    record("release app runs the game", ok, detail + (bad.length ? `; scripts that cannot instantiate: ${bad.join(", ")}` : "") + (lines.length ? `; engine printed: ${lines.slice(0, 3).join(" | ")}` : ""));
    if (ok && nJs === 0 && hasTs) console.log("  note: the pack has .ts scripts but none was attached to a node 15 frames after start (fine if your game attaches them later)");
    if (!ok) console.log(r.output.split("\n").slice(-15).join("\n"));
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
    const r = run(join(dbgApp, "Contents/MacOS", exeName), ["--headless", "--quit-after", String(frames)], { timeoutMs: 120_000 });
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

const allOk = results.every((r) => r.ok);
console.log(`\n${allOk ? "EXPORT PASS" : "EXPORT FAIL"}  ${appPath}`);
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
if (!smoke) console.log("  (--no-smoke: the app was NOT run; only the pack contents were checked)");
if (allOk) console.log("  unsigned and not notarized: see docs/SHIPPING.md before giving it to anyone");
process.exit(allOk ? 0 : 1);
