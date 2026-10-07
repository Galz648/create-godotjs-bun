// The Bun plugin as a whole (index.ts) and the switch reader (options.ts), which the other sections reach only through
// transformSourceFile. Found unchecked by the mutation pass (tools/mutate.ts, docs/design/mutation-pass.md); each case names its mutant.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSession } from "../index.ts";
import { resolveRewrites, type PluginRewrites } from "../options.ts";
import { check } from "./harness.ts";

/** Builds each file of a throwaway project through the real plugin; returns the bundle text per file and the [tooling] warnings. */
async function build(files: Record<string, string>, rewrites?: Partial<PluginRewrites>, pkg?: string): Promise<{ text: Record<string, string>; warnings: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "tooling-session-"));
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    if (pkg) writeFileSync(join(root, "package.json"), pkg);
    const session = createSession(root, rewrites);
    const text: Record<string, string> = {};
    for (const name of Object.keys(files)) {
      try {
        const built = await Bun.build({ entrypoints: [join(root, name)], root, format: "cjs", target: "browser", external: ["godot"], plugins: [session.plugin] });
        text[name] = built.success ? await built.outputs[0].text() : `THROWS: ${built.logs.join(" ")}`;
      } catch (error) {
        text[name] = `THROWS: ${String(error).split("\n")[0]}`;
      }
    }
    return { text, warnings };
  } finally {
    console.warn = warn;
    rmSync(root, { recursive: true, force: true });
  }
}

const built = await build({
  "src/filter.ts": `import { GArray } from "godot";\nexport const r = GArray.create([1]).filter((v) => true);\n`,
  "src/warn.ts": `import { Node, Resource } from "godot";\ndeclare const n: Node;\ndeclare const r: Resource;\nn.set_script(r);\n`,
  "src/helper.ts": `import { Callable } from "godot";\nexport const wrap = (owner: object, fn: () => unknown) => Callable.create(owner, fn);\n`,
});

// mutant needs-filter-map: a file whose only trigger is GArray.filter must get past the pre-filter
check(/Callable\.create\(/.test(built.text["src/filter.ts"]), "guard-session-file-with-only-filter-is-transformed", built.text["src/filter.ts"].split("\n")[0]);

// mutant load-warnings: the plugin's warnings reach the build output
check(built.warnings.some((w) => w.includes("[tooling]") && w.includes("set_script()")), "guard-session-warnings-are-printed", built.warnings[0]);

// mutants helper-cache, helper-owner: run the generated callableWithOwner against a fake engine
{
  const mod: { exports: { wrap?: (owner: object, fn: () => unknown) => () => unknown } } = { exports: {} };
  new Function("module", "exports", "require", built.text["src/helper.ts"])(mod, mod.exports, () => ({ Callable: { create: (f: unknown) => f } }));
  const o1 = {};
  const o2 = {};
  let seen: unknown = "unset";
  const fn = function (this: unknown) { seen = this; return 7; };
  const a = mod.exports.wrap?.(o1, fn);
  check(a !== undefined && a === mod.exports.wrap?.(o1, fn), "guard-owner-helper-one-wrapper-per-owner-and-fn");
  check(a !== mod.exports.wrap?.(o2, fn), "guard-owner-helper-wrappers-differ-per-owner");
  a?.();
  check(seen === o1, "guard-owner-helper-runs-fn-with-the-owner");
}

// mutant session-switch-order: an explicit switch beats package.json (the file says connect is off, the caller says on)
{
  const src = `import { Timer } from "godot";\ndeclare const t: Timer;\nt.timeout.connect(() => 1);\n`;
  const pkg = `{"godotjs":{"plugin":{"connect":false}}}`;
  const explicitOn = await build({ "src/c.ts": src }, { connect: true }, pkg);
  check(/Callable\.create\(/.test(explicitOn.text["src/c.ts"]), "guard-session-explicit-switch-beats-package-json", explicitOn.text["src/c.ts"].split("\n")[0]);
  const fromPackage = await build({ "src/c.ts": src }, undefined, pkg);
  check(fromPackage.text["src/c.ts"].startsWith("THROWS"), "guard-session-package-json-switch-applies");
}

// mutants opt-type, opt-unknown-key: package.json validation
{
  const read = (pkg: string): string => {
    const root = mkdtempSync(join(tmpdir(), "tooling-options-"));
    try {
      writeFileSync(join(root, "package.json"), pkg);
      return `ok connect=${resolveRewrites(root, {}).connect}`;
    } catch (error) {
      return String(error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  check(read(`{"godotjs":{"plugin":{"connect":false}}}`) === "ok connect=false", "guard-options-package-json-switch-read");
  check(read(`{"godotjs":{"plugin":{"connect":"no"}}}`).includes("must be true or false"), "guard-options-package-json-switch-must-be-boolean", read(`{"godotjs":{"plugin":{"connect":"no"}}}`));
  check(read(`{"godotjs":{"plugin":{"conect":false}}}`).includes("not a plugin switch"), "guard-options-package-json-unknown-switch-rejected", read(`{"godotjs":{"plugin":{"conect":false}}}`));
}
