// Update a game project's toolchain from a newer template.
//   bun tools/update.ts <template-dir> [--dry-run] [--force] [--adopt]
// <template-dir> is the starter/ of a godotjs-esm checkout, or an unpacked create-godotjs-bun template/.
// Which files are toolchain-owned is listed in tools/toolchain-files.json (in the template); nothing else is touched.
// tools/toolchain.json records {version, files: {path: sha256}} of what was last installed. A file is overwritten
// only while it still matches that record; a locally edited one is left, its diff is printed, and the exit code is 3.
//   --dry-run  show what would change, write nothing
//   --force    overwrite locally edited files too
//   --adopt    no stamp yet (project made before toolchain.json existed): treat the current files as the baseline
//   --project <dir>  update that project instead of the one this file lives in (bootstraps a project with no update.ts yet)
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export const STAMP = "tools/toolchain.json";
export type Stamp = { version: string; revision?: string; files: Record<string, string> };

/** A short hash of every toolchain file of a template: changes whenever any of them does (the package version alone does not, ticket 241). */
export function templateRevision(templateDir: string): string {
  const h = createHash("sha256");
  for (const rel of toolchainFiles(templateDir)) h.update(`${rel}:${sha(join(templateDir, rel))}\n`);
  return h.digest("hex").slice(0, 8);
}

/** package.json is game-owned and never written; list the template's scripts the project lacks, with a snippet to paste (ticket 240). */
export function missingScripts(project: string, templateDir: string): Record<string, string> {
  const read = (dir: string): Record<string, string> => {
    try { return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}; } catch { return {}; }
  };
  const have = read(project);
  const out: Record<string, string> = {};
  for (const [name, cmd] of Object.entries(read(templateDir))) if (!(name in have)) out[name] = cmd;
  return out;
}

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Toolchain-owned files of a template dir, as sorted relative paths. */
export function toolchainFiles(templateDir: string): string[] {
  const cfg = JSON.parse(readFileSync(join(templateDir, "tools/toolchain-files.json"), "utf8")) as { include: string[]; exclude?: string[] };
  const out = new Set<string>();
  for (const pattern of cfg.include) {
    for (const rel of new Bun.Glob(pattern).scanSync({ cwd: templateDir, dot: true, onlyFiles: true })) {
      if (!rel.split("/").includes("node_modules") && !lstatSync(join(templateDir, rel)).isSymbolicLink()) out.add(rel);
    }
  }
  for (const pattern of cfg.exclude ?? []) for (const rel of [...out]) if (new Bun.Glob(pattern).match(rel)) out.delete(rel);
  return [...out].sort();
}

/** Version of a template: its create-godotjs-bun package, else the one next to a starter/ checkout, else "unknown". */
export function templateVersion(templateDir: string): string {
  for (const dir of [join(templateDir, ".."), join(templateDir, "..", "packages", "create-godotjs-bun")]) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "create-godotjs-bun" && pkg.version) return pkg.version;
    } catch {
      // not a package dir
    }
  }
  return "unknown";
}

function writeStamp(project: string, stamp: Stamp): void {
  const files = Object.fromEntries(Object.entries(stamp.files).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(join(project, STAMP), `${JSON.stringify({ version: stamp.version, ...(stamp.revision ? { revision: stamp.revision } : {}), files }, null, 2)}\n`);
}

/** Scaffold time: the project's toolchain files were just copied from the template, so record their hashes. */
export function stampProject(project: string, templateDir: string, version = templateVersion(templateDir)): number {
  const files: Record<string, string> = {};
  for (const rel of toolchainFiles(templateDir)) if (existsSync(join(project, rel))) files[rel] = sha(join(project, rel));
  mkdirSync(join(project, "tools"), { recursive: true });
  writeStamp(project, { version, revision: templateRevision(templateDir), files });
  return Object.keys(files).length;
}

function unifiedDiff(current: string, incoming: string, rel: string): string {
  const r = spawnSync("diff", ["-u", "--label", `${rel} (project)`, "--label", `${rel} (template)`, current, incoming], { encoding: "utf8" });
  return r.stdout || "(binary or unreadable difference)\n";
}

export function update(project: string, templateDir: string, opts: { dryRun?: boolean; force?: boolean; adopt?: boolean }): number {
  const version = templateVersion(templateDir);
  const revision = templateRevision(templateDir);
  const stampPath = join(project, STAMP);
  let old: Stamp | undefined;
  if (existsSync(stampPath)) old = JSON.parse(readFileSync(stampPath, "utf8")) as Stamp;
  if (!old && !opts.adopt) {
    console.log(`note: ${STAMP} not found, so every differing file counts as locally edited (use --adopt to take the current files as the baseline)`);
  }
  const files: Record<string, string> = { ...(old?.files ?? {}) };
  const conflicts: string[] = [];
  let updated = 0, added = 0, same = 0;
  for (const rel of toolchainFiles(templateDir)) {
    const from = join(templateDir, rel);
    const to = join(project, rel);
    const incoming = sha(from);
    const copy = (): void => {
      if (opts.dryRun) return;
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(from));
      if (rel.startsWith(".githooks/")) chmodSync(to, 0o755);
    };
    if (!existsSync(to)) {
      console.log(`add        ${rel}`);
      copy();
      files[rel] = incoming;
      added++;
      continue;
    }
    const current = sha(to);
    if (current === incoming) {
      files[rel] = incoming;
      same++;
      continue;
    }
    const baseline = old?.files[rel] ?? (opts.adopt ? current : undefined);
    if (current === baseline || opts.force) {
      console.log(`${current === baseline ? "update     " : "overwrite  "}${rel}${current === baseline ? "" : "  (locally edited, --force)"}`);
      copy();
      files[rel] = incoming;
      updated++;
    } else {
      conflicts.push(rel);
      console.log(`CONFLICT   ${rel}  (locally edited; left as is)`);
      console.log(unifiedDiff(to, from, rel));
    }
  }
  console.log(`${opts.dryRun ? "dry run: " : ""}${added} added, ${updated} updated, ${same} already current, ${conflicts.length} left alone (template version ${version}, toolchain revision ${old?.revision ?? "unknown"} -> ${revision})`);
  const lacking = missingScripts(project, templateDir);
  if (Object.keys(lacking).length) {
    console.log(`\nnote: package.json is yours and was not changed. The template has scripts this project lacks; add them to "scripts" if you want them:\n${Object.entries(lacking).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}`);
  }
  if (!opts.dryRun) writeStamp(project, { version, revision, files });
  if (conflicts.length) {
    console.error(`\n${conflicts.length} toolchain file(s) have local edits and were not changed:\n  ${conflicts.join("\n  ")}\nKeep them as they are, or run again with --force to take the template's version (git diff shows what you lose).`);
    return 3;
  }
  return 0;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf("--project"); // bootstrap: a project too old to have update.ts runs the template's copy with --project .
  const projectFlag = pi >= 0 ? argv.splice(pi, 2)[1] : undefined;
  const flag = (f: string): boolean => argv.includes(f);
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length !== 1 || (pi >= 0 && !projectFlag) || argv.some((a) => a.startsWith("--") && !["--dry-run", "--force", "--adopt"].includes(a))) {
    console.error("usage: bun tools/update.ts <template-dir> [--dry-run] [--force] [--adopt] [--project <dir>]");
    process.exit(1);
  }
  const templateDir = resolve(positional[0]!);
  if (!existsSync(join(templateDir, "tools/toolchain-files.json"))) {
    console.error(`error: ${templateDir} is not a template (no tools/toolchain-files.json); pass the starter/ of a godotjs-esm checkout or an unpacked create-godotjs-bun template/`);
    process.exit(1);
  }
  const project = projectFlag ? resolve(projectFlag) : resolve(import.meta.dir, "..");
  if (project === templateDir) {
    console.error("error: the template is this project");
    process.exit(1);
  }
  process.exit(update(project, templateDir, { dryRun: flag("--dry-run"), force: flag("--force"), adopt: flag("--adopt") }));
}
