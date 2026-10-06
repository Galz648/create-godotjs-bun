// Web encoding globals missing in quickjs-ng; required by ES module packages such as effect.
const g = globalThis as any;
if (typeof g.TextEncoder === "undefined") {
  g.TextEncoder = class TextEncoder {
    get encoding() { return "utf-8"; }
    encode(str: any = "") {
      const out: number[] = [];
      for (const ch of String(str)) {
        const c = ch.codePointAt(0)!;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
  };
}
if (typeof g.TextDecoder === "undefined") {
  g.TextDecoder = class TextDecoder {
    get encoding() { return "utf-8"; }
    decode(buf: any = new Uint8Array(0)) {
      const b = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      let s = "";
      for (let i = 0; i < b.length; ) {
        const c = b[i++];
        let cp = c;
        if (c >= 0xf0) cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        else if (c >= 0xe0) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        else if (c >= 0xc0) cp = ((c & 31) << 6) | (b[i++] & 63);
        s += String.fromCodePoint(cp);
      }
      return s;
    }
  };
}
export {};
