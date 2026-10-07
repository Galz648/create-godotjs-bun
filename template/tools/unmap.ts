// Rewrites `.godot/GodotJS/src/main.js:LINE:COL` positions in Godot's output to the original `src/...:LINE:COL` using the .js.map next to each bundle.
// GodotJS (quickjs-ng) does not translate stack traces itself: its source-map regex expects `file.js:LINE)` without a column.
// Usage: bun run headless 2>&1 | bun tools/unmap.ts      (build with sourcemap "external", the default in tools/build.ts)
// `bun run dev` imports translate() and applies it to the game's output in a terminal (`--raw` turns that off).
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { SourceMapConsumer } from "source-map-js";

// Keyed by bundle path and the map's mtime: `bun run dev` rebuilds the maps while this process lives.
const cache = new Map<string, { mtime: number; map: SourceMapConsumer | null }>();
function consumer(file: string) {
  const map = `${file}.map`;
  const mtime = existsSync(map) ? statSync(map).mtimeMs : -1;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.map;
  let parsed: SourceMapConsumer | null = null;
  try {
    parsed = mtime >= 0 ? new SourceMapConsumer(JSON.parse(readFileSync(map, "utf8"))) : null;
  } catch { /* a map being rewritten: leave the line alone */ }
  cache.set(file, { mtime, map: parsed });
  return parsed;
}

/** One line of engine output with its `.js:line:col` positions mapped to the source; `base` is what relative paths resolve against. */
export function translate(line: string, base: string = process.cwd()): string {
  return line.replace(/((?:\/|res:\/\/)?[^\s()]+\.js):(\d+):(\d+)/g, (whole, file: string, l: string, c: string) => {
    const path = file.startsWith("res://") ? resolve(base, file.slice("res://".length)) : resolve(base, file);
    const m = consumer(path);
    if (!m) return whole;
    const pos = m.originalPositionFor({ line: Number(l), column: Number(c) - 1 });
    if (!pos.source) return whole;
    return `${relative(base, resolve(dirname(path), pos.source))}:${pos.line}:${(pos.column ?? 0) + 1}`;
  });
}

if (import.meta.main) {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) console.log(translate(line));
  }
  if (buffered) console.log(translate(buffered));
}
