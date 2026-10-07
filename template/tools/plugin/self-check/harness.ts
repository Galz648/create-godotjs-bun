// Shared harness for the plugin self-check sections: `check` prints OK/BAD and records failures, `compile`
// runs the transform over virtual files with the real engine typings.
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { transformSourceFile, type TransformOptions } from "../transform.ts";

const GODOT_DTS = join(import.meta.dir, "../types/godot.d.ts");
const ANNOT_DTS = join(import.meta.dir, "../types/godot.annotations.d.ts");

export const fails: string[] = [];
export function check(ok: boolean, label: string, detail = ""): void {
  console.log(`${ok ? "OK" : "BAD"} ${label}${detail ? " " + detail : ""}`);
  if (!ok) fails.push(label);
}

// Library and typings files do not change between compiles: parse each once (a program per check cost about 0.4 s of lib parsing).
const sharedFiles = new Map<string, ts.SourceFile | undefined>();

export function compile(files: Record<string, string>, entry: string, extra: Partial<TransformOptions> = {}): { text: string; map: ReturnType<typeof transformSourceFile> } {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: false,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    lib: ["lib.es2022.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, ...rest) => {
    if (file in files) return getSourceFile(file, ...rest);
    if (!sharedFiles.has(file)) sharedFiles.set(file, getSourceFile(file, ...rest));
    return sharedFiles.get(file);
  };
  host.fileExists = (file) => (file in files ? true : fileExists(file));
  host.readFile = (file) => (file in files ? files[file] : readFile(file));
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map((literal) => {
      let resolved: string | undefined;
      if (literal.text === "godot") resolved = GODOT_DTS;
      else if (literal.text === "godot.annotations") resolved = ANNOT_DTS;
      else if (literal.text.startsWith(".")) {
        const base = resolve(dirname(containingFile), literal.text);
        resolved = [`${base}.ts`, base].find((candidate) => candidate in files || host.fileExists(candidate));
      }
      if (!resolved) return { resolvedModule: undefined };
      return {
        resolvedModule: {
          resolvedFileName: resolved,
          extension: resolved.endsWith(".d.ts") ? ts.Extension.Dts : ts.Extension.Ts,
        },
      };
    });
  const program = ts.createProgram({ rootNames: [entry], options, host });
  const sf = program.getSourceFile(entry);
  if (!sf) throw new Error(`missing source ${entry}`);
  const result = transformSourceFile(sf, program.getTypeChecker(), { gdModule: "/virtual/lib/gd.ts", ...extra });
  return { text: result?.map.generatedText ?? files[entry], map: result };
}

export function mustThrow(files: Record<string, string>, entry: string, needle: string, label: string): void {
  try {
    compile(files, entry);
    check(false, label, "did not throw");
  } catch (error) {
    const message = String(error);
    check(message.includes(needle), label, message.split("\n")[0]);
  }
}

/** "file:line:col" of the first occurrence of `needle` in `src`. */
export function at(file: string, src: string, needle: string, nth = 0): string {
  let index = -1;
  for (let i = 0; i <= nth; i++) index = src.indexOf(needle, index + 1);
  if (index < 0) throw new Error(`self-check bug: ${needle} not in source`);
  const before = src.slice(0, index).split("\n");
  return `${file}:${before.length}:${before[before.length - 1].length + 1}`;
}

export function warningsOf(files: Record<string, string>, entry: string): string[] {
  return compile(files, entry).map?.warnings ?? [];
}

export function mustThrowAt(files: Record<string, string>, entry: string, needle: string, position: string, label: string): void {
  try {
    compile(files, entry);
    check(false, label, "did not throw");
  } catch (error) {
    const message = String(error);
    check(message.includes(`${position} `) && message.includes(needle), label, message.split("\n")[0]);
  }
}

export const gdDecl = `declare const gd: any;\n`;
