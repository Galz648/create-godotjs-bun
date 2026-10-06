// Rewrites `.godot/GodotJS/src/main.js:LINE:COL` positions in Godot's output to the original `src/...:LINE:COL` using the .js.map next to each bundle.
// GodotJS (quickjs-ng) does not translate stack traces itself: its source-map regex expects `file.js:LINE)` without a column.
// Usage: bun run headless 2>&1 | bun tools/unmap.ts      (build with sourcemap "external", the default in tools/build.ts)
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { SourceMapConsumer } from "source-map-js";

const cache = new Map<string, SourceMapConsumer | null>();
function consumer(file: string) {
  if (!cache.has(file)) {
    const map = `${file}.map`;
    cache.set(file, existsSync(map) ? new SourceMapConsumer(JSON.parse(readFileSync(map, "utf8"))) : null);
  }
  return cache.get(file)!;
}

const decoder = new TextDecoder();
let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) console.log(translate(line));
}
if (buffered) console.log(translate(buffered));

function translate(line: string): string {
  return line.replace(/((?:\/|res:\/\/)?[^\s()]+\.js):(\d+):(\d+)/g, (whole, file: string, l: string, c: string) => {
    const path = file.startsWith("res://") ? resolve(file.slice("res://".length)) : resolve(file);
    const m = consumer(path);
    if (!m) return whole;
    const pos = m.originalPositionFor({ line: Number(l), column: Number(c) - 1 });
    if (!pos.source) return whole;
    return `${relative(process.cwd(), resolve(dirname(path), pos.source))}:${pos.line}:${(pos.column ?? 0) + 1}`;
  });
}
