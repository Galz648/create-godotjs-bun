// Read the file table of a Godot .pck (format versions 2 and 3, unencrypted directory).
// Used by tools/export.ts to check what really went into the exported app.
import { readFileSync } from "node:fs";

export type PckEntry = { path: string; offset: number; size: number };

export function readPck(file: string): { version: number; entries: PckEntry[] } {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x43504447) throw new Error(`${file} is not a Godot pack (no GDPC magic)`);
  const version = buf.readUInt32LE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack format version ${version}`);
  const flags = buf.readUInt32LE(20);
  if (flags & 1) throw new Error("the pack directory is encrypted; cannot inspect it");
  let pos: number;
  if (version === 3) pos = Number(buf.readBigUInt64LE(32)); // dir_offset
  else pos = 32 + 64; // v2: file_base u64 then 16 reserved u32
  const count = buf.readUInt32LE(pos);
  pos += 4;
  const entries: PckEntry[] = [];
  for (let i = 0; i < count; i++) {
    const len = buf.readUInt32LE(pos);
    pos += 4;
    const path = buf.toString("utf8", pos, pos + len).replace(/\0+$/, "");
    pos += len;
    const offset = Number(buf.readBigUInt64LE(pos));
    const size = Number(buf.readBigUInt64LE(pos + 8));
    pos += 8 + 8 + 16 + 4; // offset, size, md5, flags
    entries.push({ path, offset, size });
  }
  return { version, entries };
}
