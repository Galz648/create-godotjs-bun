// Pure Bun check, no engine: the dev build relies on Bun's identifier renamer keeping the per-class decorator
// lowering temporaries apart (docs/design/cross-file-decorators.md). If a Bun upgrade breaks that, this fails.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_MINIFY } from "../../build.ts";
import { check } from "./harness.ts";

const dir = mkdtempSync(join(tmpdir(), "godotjs-bundle-check-"));
try {
  mkdirSync(dir, { recursive: true });
  const dec = `export function d(_v: unknown, c: ClassAccessorDecoratorContext) { return { init(v: number) { console.log("init " + String(c.name)); return v; } }; }\n`;
  writeFileSync(join(dir, "a.ts"), `${dec}export class A { @d accessor a = 1; }\n`);
  writeFileSync(join(dir, "b.ts"), `import { A, d } from "./a";\nexport class B extends A { @d accessor b = 2; }\nnew B();\n`);
  const run = async (minify: false | typeof DEV_MINIFY) => {
    const out = join(dir, minify ? "ids" : "plain");
    const built = await Bun.build({ entrypoints: [join(dir, "b.ts")], outdir: out, format: "cjs", target: "browser", minify });
    if (!built.success) return `build failed: ${built.logs.join(" ")}`;
    const ran = Bun.spawnSync([process.execPath, join(out, "b.js")]);
    return ran.stdout.toString().trim().split("\n").join(",");
  };
  const bun = Bun.version;
  const withIds = await run(DEV_MINIFY);
  check(withIds === "init a,init b", "bundle-identifier-renaming-keeps-decorated-classes-apart", `bun ${bun}: ${withIds}`);
  // Information only: when a Bun release fixes the collision this prints init a,init b and the workaround can be reviewed.
  console.log(`INFO bun ${bun} without renaming: ${await run(false)} (broken is "init b,init b")`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
