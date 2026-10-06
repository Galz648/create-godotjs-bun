// Text edits plus a range map from generated offsets back to the original file.
// Composition looks up the exact generated offset. The bundle map is rewritten with a
// direct VLQ pass so a fat dependency graph is not loaded into source-map-js.

export interface Part {
  text: string;
  /** Original offset this slice was copied from. Length is text.length. */
  from?: number;
  /** Original offset a generated slice should blame. */
  at?: number;
}

export interface Edit {
  start: number;
  end: number;
  parts: Part[];
}

export interface Range {
  genStart: number;
  genEnd: number;
  origStart: number;
  point: boolean;
}

export interface TransformMap {
  originalText: string;
  generatedText: string;
  ranges: Range[];
  originalStarts: number[];
  generatedStarts: number[];
}

export function applyEdits(source: string, edits: Edit[]): { text: string; ranges: Range[] } {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.start < prev.end) {
      throw new Error(`overlapping edits ${prev.start}-${prev.end} and ${cur.start}-${cur.end}`);
    }
  }
  let text = "";
  const ranges: Range[] = [];
  let cursor = 0;
  let gen = 0;
  const pushCopy = (start: number, end: number) => {
    if (end <= start) return;
    text += source.slice(start, end);
    ranges.push({ genStart: gen, genEnd: gen + (end - start), origStart: start, point: false });
    gen += end - start;
  };
  for (const edit of sorted) {
    pushCopy(cursor, edit.start);
    for (const part of edit.parts) {
      text += part.text;
      const len = part.text.length;
      if (len === 0) continue;
      if (part.from !== undefined) {
        ranges.push({ genStart: gen, genEnd: gen + len, origStart: part.from, point: false });
      } else {
        ranges.push({ genStart: gen, genEnd: gen + len, origStart: part.at ?? edit.start, point: true });
      }
      gen += len;
    }
    cursor = edit.end;
  }
  pushCopy(cursor, source.length);
  return { text, ranges };
}

export function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

export function offsetToPos(starts: number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  const lineIdx = Math.max(0, hi);
  return { line: lineIdx + 1, col: offset - starts[lineIdx] };
}

export function posToOffset(starts: number[], line: number, col: number): number {
  const idx = line - 1;
  if (idx < 0 || idx >= starts.length) return starts[starts.length - 1] ?? 0;
  return starts[idx] + col;
}

export function lookupOriginal(ranges: Range[], genOffset: number): number | null {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];
    if (genOffset < range.genStart) hi = mid - 1;
    else if (genOffset >= range.genEnd) lo = mid + 1;
    else return range.point ? range.origStart : range.origStart + (genOffset - range.genStart);
  }
  return null;
}

export function toTransformMap(originalText: string, generatedText: string, ranges: Range[]): TransformMap {
  return {
    originalText,
    generatedText,
    ranges,
    originalStarts: lineStartsOf(originalText),
    generatedStarts: lineStartsOf(generatedText),
  };
}

interface RawMap {
  version: number;
  file?: string;
  sources: string[];
  names?: string[];
  mappings: string;
  sourcesContent?: (string | null)[];
  sourceRoot?: string;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INT = new Int32Array(128);
for (let i = 0; i < B64.length; i++) B64_INT[B64.charCodeAt(i)] = i;

function decodeVLQ(text: string, index: number): { value: number; index: number } {
  let result = 0;
  let shift = 0;
  let digit = 0;
  do {
    digit = B64_INT[text.charCodeAt(index++)];
    result |= (digit & 31) << shift;
    shift += 5;
  } while (digit & 32);
  const negate = result & 1;
  result >>>= 1;
  return { value: negate ? -result : result, index };
}

function encodeVLQ(value: number): string {
  let vlq = value < 0 ? (-value << 1) + 1 : (value << 1);
  let out = "";
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    out += B64[digit];
  } while (vlq > 0);
  return out;
}

function remapMappings(
  mappings: string,
  adjust: (source: number, line0: number, col: number) => { line: number; col: number } | null,
): string {
  const parts: string[] = [];
  let i = 0;
  let decodedGen = 0;
  let decodedSource = 0;
  let decodedLine = 0;
  let decodedCol = 0;
  let decodedName = 0;
  let emittedGen = 0;
  let emittedSource = 0;
  let emittedLine = 0;
  let emittedCol = 0;
  let emittedName = 0;
  const n = mappings.length;
  while (i < n) {
    const ch = mappings[i];
    if (ch === ";") {
      parts.push(";");
      i++;
      decodedGen = 0;
      emittedGen = 0;
      continue;
    }
    if (ch === ",") {
      parts.push(",");
      i++;
      continue;
    }
    const fields: number[] = [];
    while (i < n && mappings[i] !== "," && mappings[i] !== ";") {
      const decoded = decodeVLQ(mappings, i);
      fields.push(decoded.value);
      i = decoded.index;
    }
    if (fields.length === 0) continue;
    const gen = decodedGen + fields[0];
    decodedGen = gen;
    if (fields.length < 4) {
      parts.push(encodeVLQ(gen - emittedGen));
      emittedGen = gen;
      continue;
    }
    const source = decodedSource + fields[1];
    decodedSource = source;
    let line = decodedLine + fields[2];
    decodedLine = line;
    let col = decodedCol + fields[3];
    decodedCol = col;
    let name: number | null = null;
    if (fields.length >= 5) {
      name = decodedName + fields[4];
      decodedName = name;
    }
    const next = adjust(source, line, col);
    if (next) {
      line = next.line;
      col = next.col;
    }
    let seg = encodeVLQ(gen - emittedGen) + encodeVLQ(source - emittedSource) + encodeVLQ(line - emittedLine) + encodeVLQ(col - emittedCol);
    emittedGen = gen;
    emittedSource = source;
    emittedLine = line;
    emittedCol = col;
    if (name != null) {
      seg += encodeVLQ(name - emittedName);
      emittedName = name;
    }
    parts.push(seg);
  }
  return parts.join("");
}

/** Rewrite bundle→transformed mappings into bundle→original, using each source's transform. */
export function composeMappings(map: RawMap, lookup: (source: string | null) => TransformMap | undefined): RawMap {
  const transforms = map.sources.map((source) => lookup(source));
  if (!transforms.some((transform) => transform)) return map;
  const mappings = remapMappings(map.mappings, (source, line0, col) => {
    const transform = transforms[source];
    if (!transform) return null;
    const genOff = posToOffset(transform.generatedStarts, line0 + 1, col);
    const origOff = lookupOriginal(transform.ranges, genOff);
    if (origOff == null) return null;
    const pos = offsetToPos(transform.originalStarts, origOff);
    return { line: pos.line - 1, col: pos.col };
  });
  return { ...map, mappings };
}
