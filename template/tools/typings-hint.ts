// Stale-typings hint (ticket 440). The generated typings (`bun run types`) carry the project's InputMap as the
// `InputActionName` union, so an action added to project.godot fails the type check until the typings are made again:
//   Argument of type '"move_left"' is not assignable to parameter of type 'InputActionName'
// `bun run build` prints this hint when it applies; `bun run typecheck` prints it after a failing tsc:
//   bun tools/typings-hint.ts --tsc-failed      (prints the hint if it applies, always exits 1)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The action names of the `InputActionName` union in a generated typings file. */
export function inputActions(typingsText: string): Set<string> {
  const start = typingsText.indexOf("type InputActionName");
  if (start < 0) return new Set();
  const names = new Set<string>();
  for (const line of typingsText.slice(start).split("\n").slice(1)) {
    const m = /^\s*\|\s*"([^"]+)"\s*$/.exec(line);
    if (!m) break;
    names.add(m[1]);
  }
  return names;
}

/** The action names of project.godot's [input] section. */
export function projectActions(projectText: string): string[] {
  const lines = projectText.split("\n");
  const out: string[] = [];
  let inInput = false;
  for (const line of lines) {
    if (/^\[.*\]\s*$/.test(line)) { inInput = line.trim() === "[input]"; continue; }
    const m = inInput ? /^([A-Za-z_][\w./-]*)\s*=\s*\{/.exec(line) : null;
    if (m) out.push(m[1]);
  }
  return out;
}

/** A one-line hint when project.godot has input actions the generated typings lack; null when they agree or no typings exist. */
export function staleTypingsHint(root: string): string | null {
  const gen = join(root, "typings", "godot0.gen.d.ts");
  const project = join(root, "project.godot");
  if (!existsSync(gen) || !existsSync(project)) return null; // the stub typings take any string
  const known = inputActions(readFileSync(gen, "utf8"));
  if (known.size === 0) return null; // a typings layout this check does not understand: say nothing rather than something wrong
  const missing = projectActions(readFileSync(project, "utf8")).filter((a) => !known.has(a));
  if (missing.length === 0) return null;
  return `hint: input action(s) ${missing.join(", ")} are in project.godot but not in the generated typings: run \`bun run types\` (the typings carry the InputMap; until then \`Input.is_action_pressed("${missing[0]}")\` fails the type check with "not assignable to parameter of type 'InputActionName'")`;
}

if (import.meta.main) {
  const hint = staleTypingsHint(join(import.meta.dir, ".."));
  if (hint) console.error(hint);
  process.exit(process.argv.includes("--tsc-failed") ? 1 : 0);
}
