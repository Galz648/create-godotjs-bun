// OPT-IN polyfill: URL and URLSearchParams (a pragmatic WHATWG subset). Import it explicitly:
//   import "../polyfills/url.js";   // before any code that uses URL
// Guarded by `typeof`: a host that already has the global (Bun, a browser, a newer engine) keeps its own.
// Tested differentially against Bun by starter/tests/bun-parity. What is NOT covered is listed in docs/design/bun-parity.md:
// IDNA beyond NFKC + lower case + punycode (no UTS46 disallowed-code-point checks), URL.createObjectURL / revokeObjectURL, blob: origins, the `host`/`protocol` setter corner cases of the spec, error message text (the name is TypeError).
(function (g) {
  "use strict";
  var needSP = typeof g.URLSearchParams === "undefined";
  var needURL = typeof g.URL === "undefined";
  if (!needSP && !needURL) return;

  // ---- encoding helpers -------------------------------------------------------------------------------------------
  var HEXD = "0123456789ABCDEF";
  function utf8(cp) {
    if (cp < 0x80) return [cp];
    if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 63)];
    if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
    return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
  }
  // percent-encode every code point that `keep` rejects (and everything non-ASCII), as UTF-8; lone surrogates become U+FFFD
  function encode(s, keep) {
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i), cp = c;
      if (c >= 0xd800 && c < 0xe000) {
        var d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (c < 0xdc00 && d >= 0xdc00 && d < 0xe000) { cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } else cp = 0xfffd;
      }
      if (cp < 0x80 && keep(cp)) out += String.fromCharCode(cp);
      else { var b = utf8(cp); for (var j = 0; j < b.length; j++) out += "%" + HEXD[b[j] >> 4] + HEXD[b[j] & 15]; }
    }
    return out;
  }
  // a code point set: printable ASCII except the listed characters
  function setOf(str) { return function (cp) { return cp >= 0x20 && cp < 0x7f && str.indexOf(String.fromCharCode(cp)) < 0; }; }
  var C0 = setOf(""), FRAG = setOf(' "<>`'), QUERY = setOf(' "#<>'), SQUERY = setOf(" \"#<>'"), PATH = setOf(' "#<>?^`{}'), USER = setOf(' "#<>?^`{}/:;=@[\\]|');
  function formKeep(cp) { return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 42 || cp === 45 || cp === 46 || cp === 95; }
  function formEncode(s) { return encode(s, formKeep).replace(/%20/g, "+"); }

  function hexv(c) { return c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1; }
  // percent-decode to bytes (non-ASCII characters contribute their UTF-8 bytes)
  function pctBytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 37 && i + 2 < s.length + 0 && hexv(s.charCodeAt(i + 1)) >= 0 && hexv(s.charCodeAt(i + 2)) >= 0) {
        out.push(hexv(s.charCodeAt(i + 1)) * 16 + hexv(s.charCodeAt(i + 2))); i += 2; continue;
      }
      var cp = c;
      if (c >= 0xd800 && c < 0xe000) {
        var d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (c < 0xdc00 && d >= 0xdc00 && d < 0xe000) { cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } else cp = 0xfffd;
      }
      var b = utf8(cp); for (var j = 0; j < b.length; j++) out.push(b[j]);
    }
    return out;
  }
  // UTF-8 decode with U+FFFD replacement (WHATWG decoder, maximal subparts)
  function utf8Decode(bytes) {
    var out = "", need = 0, seen = 0, cp = 0, lo = 0x80, hi = 0xbf;
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (need === 0) {
        if (b < 0x80) out += String.fromCharCode(b);
        else if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; }
        else if (b >= 0xe0 && b <= 0xef) { if (b === 0xe0) lo = 0xa0; if (b === 0xed) hi = 0x9f; need = 2; cp = b & 0xf; }
        else if (b >= 0xf0 && b <= 0xf4) { if (b === 0xf0) lo = 0x90; if (b === 0xf4) hi = 0x8f; need = 3; cp = b & 7; }
        else out += "�";
        continue;
      }
      if (b < lo || b > hi) { cp = need = seen = 0; lo = 0x80; hi = 0xbf; out += "�"; i--; continue; }
      lo = 0x80; hi = 0xbf; cp = (cp << 6) | (b & 63); seen++;
      if (seen === need) { out += String.fromCodePoint(cp); cp = need = seen = 0; }
    }
    if (need) out += "�";
    return out;
  }
  function pctDecode(s) { return utf8Decode(pctBytes(s)); }
  function usv(v) { return ("" + `${v}`).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�"); }

  // ---- URLSearchParams --------------------------------------------------------------------------------------------
  var spState = new WeakMap(); // URLSearchParams -> { list: [[name, value]], url: record owner or null }
  function st(o) { var s = spState.get(o); if (!s) throw new TypeError("Can only call URLSearchParams methods on instances of URLSearchParams"); return s; }
  function parseForm(s) {
    var list = [], parts = s.split("&");
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === "") continue;
      var eq = parts[i].indexOf("="), n = eq < 0 ? parts[i] : parts[i].slice(0, eq), v = eq < 0 ? "" : parts[i].slice(eq + 1);
      list.push([pctDecode(n.replace(/\+/g, " ")), pctDecode(v.replace(/\+/g, " "))]);
    }
    return list;
  }
  function serializeForm(list) { return list.map(function (p) { return formEncode(p[0]) + "=" + formEncode(p[1]); }).join("&"); }
  function changed(s) { if (s.url) s.url(serializeForm(s.list)); }
  function need(args, n, what) { if (args.length < n) throw new TypeError("Not enough arguments to URLSearchParams." + what); }

  class URLSearchParams {
    constructor(init) {
      var s = { list: [], url: null };
      spState.set(this, s);
      if (init === undefined) return;
      if (init !== null && typeof init === "object") {
        if (typeof init[Symbol.iterator] === "function") {
          for (var pair of init) {
            if (pair === null || typeof pair !== "object" || typeof pair[Symbol.iterator] !== "function") throw new TypeError("Expected a sequence of pairs");
            var two = Array.from(pair);
            if (two.length !== 2) throw new TypeError("Expected 2 items in pair but got " + two.length);
            s.list.push([usv(two[0]), usv(two[1])]);
          }
        } else {
          var keys = Reflect.ownKeys(init);
          for (var i = 0; i < keys.length; i++) {
            var d = Object.getOwnPropertyDescriptor(init, keys[i]);
            if (d && d.enumerable) s.list.push([usv(keys[i]), usv(init[keys[i]])]); // a Symbol key throws TypeError, as in Bun
          }
        }
      } else {
        var str = usv(init);
        s.list = parseForm(str[0] === "?" ? str.slice(1) : str);
      }
    }
    get size() { return st(this).list.length; }
    get length() { return st(this).list.length; } // Bun extension
    toJSON() { // Bun extension: {name: value} with an array for a repeated name
      var o = {}, l = st(this).list;
      for (var i = 0; i < l.length; i++) {
        var k = l[i][0], cur = Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
        var v = cur === undefined ? l[i][1] : Array.isArray(cur) ? cur.concat([l[i][1]]) : [cur, l[i][1]];
        Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
      }
      Object.defineProperty(o, Symbol.toStringTag, { value: "URLSearchParams", configurable: true });
      return o;
    }
    append(name, value) { need(arguments, 2, "append"); var s = st(this); s.list.push([usv(name), usv(value)]); changed(s); }
    delete(name, value) {
      need(arguments, 1, "delete"); var s = st(this); name = `${name}`; // lookups do not convert lone surrogates (Bun); only append/set/init do
      var v = value === undefined ? undefined : `${value}`;
      s.list = s.list.filter(function (p) { return !(p[0] === name && (v === undefined || p[1] === v)); });
      changed(s);
    }
    get(name) { need(arguments, 1, "get"); name = `${name}`; var l = st(this).list; for (var i = 0; i < l.length; i++) if (l[i][0] === name) return l[i][1]; return null; }
    getAll(name) { need(arguments, 1, "getAll"); name = `${name}`; return st(this).list.filter(function (p) { return p[0] === name; }).map(function (p) { return p[1]; }); }
    has(name, value) {
      need(arguments, 1, "has"); name = `${name}`; var v = value === undefined ? undefined : `${value}`;
      return st(this).list.some(function (p) { return p[0] === name && (v === undefined || p[1] === v); });
    }
    set(name, value) {
      need(arguments, 2, "set"); var s = st(this); name = usv(name); value = usv(value);
      var found = false, out = [];
      for (var i = 0; i < s.list.length; i++) {
        if (s.list[i][0] !== name) out.push(s.list[i]);
        else if (!found) { found = true; out.push([name, value]); }
      }
      if (!found) out.push([name, value]);
      s.list = out; changed(s);
    }
    sort() { var s = st(this); s.list = s.list.map(function (p, i) { return [p, i]; }).sort(function (a, b) { return a[0][0] < b[0][0] ? -1 : a[0][0] > b[0][0] ? 1 : a[1] - b[1]; }).map(function (x) { return x[0]; }); changed(s); }
    forEach(cb, thisArg) {
      if (typeof cb !== "function") throw new TypeError("The callback provided as parameter 1 is not a function");
      var s = st(this);
      for (var i = 0; i < s.list.length; i++) cb.call(thisArg, s.list[i][1], s.list[i][0], this);
    }
    entries() { return makeIter(st(this), 2); }
    keys() { return makeIter(st(this), 0); }
    values() { return makeIter(st(this), 1); }
    toString() { return serializeForm(st(this).list); }
  }
  Object.defineProperty(URLSearchParams.prototype, Symbol.iterator, { value: URLSearchParams.prototype.entries, writable: true, configurable: true });
  Object.defineProperty(URLSearchParams.prototype, Symbol.toStringTag, { value: "URLSearchParams", configurable: true });
  var IterProto = {
    next: function () {
      var s = this.s;
      if (this.i >= s.list.length) return { value: undefined, done: true };
      var p = s.list[this.i++];
      return { value: this.k === 0 ? p[0] : this.k === 1 ? p[1] : [p[0], p[1]], done: false };
    }
  };
  Object.defineProperty(IterProto, Symbol.iterator, { value: function () { return this; } });
  Object.defineProperty(IterProto, Symbol.toStringTag, { value: "URLSearchParams Iterator", configurable: true });
  function makeIter(s, k) { var it = Object.create(IterProto); it.s = s; it.i = 0; it.k = k; return it; }

  // ---- URL parsing (record: scheme, username, password, host|null, port|null, path (array | opaque string), query|null, fragment|null)
  var SPECIAL = { http: 80, https: 443, ws: 80, wss: 443, ftp: 21, file: null };
  function isSpecial(sc) { return Object.prototype.hasOwnProperty.call(SPECIAL, sc); }
  var FORBID_DOMAIN = /[\u0000- #%\/:<>?@\[\\\]^|\u007f]/, FORBID_OPAQUE = /[\u0000\t\n\r #\/:<>?@\[\\\]^|]/;

  function parseIPv4Part(s) {
    if (s === "") return NaN;
    var r = 10;
    if (s.length >= 2 && (s.slice(0, 2) === "0x" || s.slice(0, 2) === "0X")) { s = s.slice(2); r = 16; }
    else if (s.length >= 2 && s[0] === "0") { s = s.slice(1); r = 8; }
    if (s === "") return 0;
    if (!(r === 10 ? /^[0-9]+$/ : r === 16 ? /^[0-9a-fA-F]+$/ : /^[0-7]+$/).test(s)) return NaN;
    return parseInt(s, r);
  }
  // IPv6 per the WHATWG algorithm: parse (with "::" and an embedded IPv4 tail), then serialise with the longest zero run compressed
  function parseIPv6(s) {
    var a = [0, 0, 0, 0, 0, 0, 0, 0], piece = 0, compress = null, p = 0, n = s.length;
    if (s[p] === ":") { if (s[p + 1] !== ":") return null; p += 2; piece++; compress = piece; }
    while (p < n) {
      if (piece === 8) return null;
      if (s[p] === ":") { if (compress !== null) return null; p++; piece++; compress = piece; continue; }
      var value = 0, len = 0;
      while (len < 4 && p < n && hexv(s.charCodeAt(p)) >= 0) { value = value * 16 + hexv(s.charCodeAt(p)); p++; len++; }
      if (s[p] === ".") {
        if (len === 0) return null;
        p -= len;
        if (piece > 6) return null;
        var seen = 0;
        while (p < n) {
          var part = null;
          if (seen > 0) { if (s[p] === "." && seen < 4) p++; else return null; }
          if (p >= n || s[p] < "0" || s[p] > "9") return null;
          while (p < n && s[p] >= "0" && s[p] <= "9") {
            var d = s.charCodeAt(p) - 48;
            if (part === null) part = d; else if (part === 0) return null; else part = part * 10 + d;
            if (part > 255) return null;
            p++;
          }
          a[piece] = a[piece] * 256 + part;
          seen++;
          if (seen === 2 || seen === 4) piece++;
        }
        if (seen !== 4) return null;
        break;
      } else if (s[p] === ":") { p++; if (p >= n) return null; }
      else if (p < n) return null;
      a[piece] = value; piece++;
    }
    if (compress !== null) {
      var swaps = piece - compress; piece = 7;
      while (piece !== 0 && swaps > 0) { var t = a[compress + swaps - 1]; a[compress + swaps - 1] = a[piece]; a[piece] = t; piece--; swaps--; }
    } else if (piece !== 8) return null;
    var best = -1, bestLen = 1, i = 0;
    while (i < 8) {
      if (a[i] !== 0) { i++; continue; }
      var j = i; while (j < 8 && a[j] === 0) j++;
      if (j - i > bestLen) { best = i; bestLen = j - i; }
      i = j;
    }
    var out = "", ignore0 = false;
    for (i = 0; i < 8; i++) {
      if (ignore0 && a[i] === 0) continue;
      ignore0 = false;
      if (best === i) { out += i === 0 ? "::" : ":"; ignore0 = true; continue; }
      out += a[i].toString(16);
      if (i !== 7) out += ":";
    }
    return out;
  }
  // punycode (RFC 3492) encoding of one label, for IDNA; the UTS46 mapping is approximated by NFKC + lower case
  function punyEncode(label) {
    var cps = Array.from(label, function (c) { return c.codePointAt(0); }), out = "", i, n = 128, delta = 0, bias = 72, h, b;
    for (i = 0; i < cps.length; i++) if (cps[i] < 128) out += String.fromCharCode(cps[i]);
    h = b = out.length;
    if (b) out += "-";
    function dg(d) { return String.fromCharCode(d < 26 ? d + 97 : d + 22); }
    function adapt(d, num, first) { var k = 0; d = first ? Math.floor(d / 700) : d >> 1; d += Math.floor(d / num); for (; d > 455; k += 36) d = Math.floor(d / 35); return k + Math.floor(36 * d / (d + 38)); }
    while (h < cps.length) {
      var m = 0x7fffffff;
      for (i = 0; i < cps.length; i++) if (cps[i] >= n && cps[i] < m) m = cps[i];
      delta += (m - n) * (h + 1); n = m;
      for (i = 0; i < cps.length; i++) {
        if (cps[i] < n) delta++;
        if (cps[i] === n) {
          var q = delta;
          for (var k = 36; ; k += 36) {
            var t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
            if (q < t) break;
            out += dg(t + (q - t) % (36 - t)); q = Math.floor((q - t) / (36 - t));
          }
          out += dg(q); bias = adapt(delta, h + 1, h === b); delta = 0; h++;
        }
      }
      delta++; n++;
    }
    return out;
  }
  function toASCII(d) {
    d = d.normalize("NFKC").toLowerCase().replace(/[\u3002\uff0e\uff61]/g, ".");
    return d.split(".").map(function (l) { return /[^\u0000-\u007f]/.test(l) ? "xn--" + punyEncode(l) : l; }).join(".");
  }
  function parseHost(input, special) {
    if (input[0] === "[") {
      if (input[input.length - 1] !== "]") return null;
      var v6 = parseIPv6(input.slice(1, -1));
      return v6 === null ? null : "[" + v6 + "]";
    }
    if (!special) return FORBID_OPAQUE.test(input) ? null : encode(input, C0);
    var d = pctDecode(input);
    if (d.indexOf("\ufffd") >= 0) return null; // invalid UTF-8 after percent-decoding is not a valid domain
    d = toASCII(d);
    if (d === "" || FORBID_DOMAIN.test(d)) return null;
    var parts = d.split(".");
    if (parts[parts.length - 1] === "" && parts.length > 1) parts.pop();
    var last = parts[parts.length - 1];
    if (/^[0-9]+$/.test(last) || /^0[xX][0-9a-fA-F]*$/.test(last)) { // ends in a number: must be an IPv4 address
      if (parts.length > 4) return null;
      var nums = [];
      for (var i = 0; i < parts.length; i++) { var n = parseIPv4Part(parts[i]); if (n !== n) return null; nums.push(n); }
      for (var j = 0; j < nums.length - 1; j++) if (nums[j] > 255) return null;
      if (nums[nums.length - 1] >= Math.pow(256, 5 - nums.length)) return null;
      var ip = nums[nums.length - 1];
      for (var k = 0; k < nums.length - 1; k++) ip += nums[k] * Math.pow(256, 3 - k);
      return [Math.floor(ip / 16777216) % 256, Math.floor(ip / 65536) % 256, Math.floor(ip / 256) % 256, ip % 256].join(".");
    }
    return d;
  }
  function clone(r) { return { scheme: r.scheme, username: r.username, password: r.password, host: r.host, port: r.port, path: typeof r.path === "string" ? r.path : r.path.slice(), query: r.query, fragment: r.fragment }; }
  function isDrive(s) { return s.length === 2 && /[a-zA-Z]/.test(s[0]) && (s[1] === ":" || s[1] === "|"); }
  // apply path segments (already split) onto rec.path
  function addSegments(rec, segs) {
    var special = isSpecial(rec.scheme);
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i], last = i === segs.length - 1;
      if (/^(\.|%2e)(\.|%2e)$/i.test(seg)) {
        if (!(rec.scheme === "file" && rec.path.length === 1 && isDrive(rec.path[0]) && rec.path[0][1] === ":")) rec.path.pop();
        if (last) rec.path.push("");
      } else if (/^(\.|%2e)$/i.test(seg)) {
        if (last) rec.path.push("");
      } else {
        if (rec.scheme === "file" && rec.path.length === 0 && isDrive(seg)) seg = seg[0] + ":";
        rec.path.push(encode(seg, PATH));
      }
    }
    return special;
  }
  var SLASH_SPECIAL = /[\/\\]/, SLASH_PLAIN = /\//;
  // `main` begins with the path (after the authority) or is "" ; sets rec.path from scratch
  function setPath(rec, main) {
    var special = isSpecial(rec.scheme);
    rec.path = [];
    if (main === "") { if (special) rec.path = [""]; return; }
    addSegments(rec, main.slice(1).split(special ? SLASH_SPECIAL : SLASH_PLAIN));
  }
  function splitTail(s) {
    var h = s.indexOf("#"), fragment = null, query = null;
    if (h >= 0) { fragment = s.slice(h + 1); s = s.slice(0, h); }
    var q = s.indexOf("?");
    if (q >= 0) { query = s.slice(q + 1); s = s.slice(0, q); }
    return { main: s, query: query, fragment: fragment };
  }
  function finish(rec, t, keepQuery) {
    if (t.query !== null) rec.query = encode(t.query, isSpecial(rec.scheme) ? SQUERY : QUERY);
    else if (!keepQuery) rec.query = null;
    rec.fragment = t.fragment === null ? null : encode(t.fragment, FRAG);
    return rec;
  }
  function blank(scheme) { return { scheme: scheme, username: "", password: "", host: null, port: null, path: [], query: null, fragment: null }; }
  // `main` starts at the authority (after "//"). Fills username/password/host/port and path
  function parseAuthority(rec, main) {
    var special = isSpecial(rec.scheme), re = special ? SLASH_SPECIAL : SLASH_PLAIN;
    var end = main.search(re); if (end < 0) end = main.length;
    var auth = main.slice(0, end), pathStr = main.slice(end);
    var at = auth.lastIndexOf("@");
    if (at >= 0) {
      var info = auth.slice(0, at); auth = auth.slice(at + 1);
      if (auth === "") return null;
      var colon = info.indexOf(":");
      rec.username = encode(colon < 0 ? info : info.slice(0, colon), USER);
      rec.password = colon < 0 ? "" : encode(info.slice(colon + 1), USER);
    }
    var hostStr = auth, portStr = "";
    if (auth[0] === ":") return null; // a port without a host
    if (auth[0] === "[") {
      var rb = auth.indexOf("]");
      if (rb < 0) return null;
      hostStr = auth.slice(0, rb + 1);
      var rest = auth.slice(rb + 1);
      if (rest !== "") { if (rest[0] !== ":") return null; portStr = rest.slice(1); }
    } else {
      var c = auth.indexOf(":");
      if (c >= 0) { hostStr = auth.slice(0, c); portStr = auth.slice(c + 1); }
    }
    if (hostStr === "" && special && rec.scheme !== "file") return null;
    if (hostStr === "" && (rec.username !== "" || rec.password !== "" || portStr !== "" || at >= 0) && special) return null;
    if (portStr !== "") {
      if (!/^[0-9]+$/.test(portStr)) return null;
      var n = parseInt(portStr, 10);
      if (n > 65535) return null;
      rec.port = SPECIAL[rec.scheme] === n ? null : n;
    }
    if (hostStr === "" && !special && portStr !== "") return null;
    var host = hostStr === "" ? "" : parseHost(hostStr, special);
    if (host === null) return null;
    if (rec.scheme === "file" && host === "localhost") host = "";
    rec.host = host;
    setPath(rec, pathStr);
    return rec;
  }
  function parseFile(rest, base) {
    var t = splitTail(rest), main = t.main, rec = blank("file");
    var two = /^[\/\\]{2}/.test(main);
    if (two) {
      var m = main.slice(2), e = m.search(/[\/\\]/); if (e < 0) e = m.length;
      var hostStr = m.slice(0, e);
      if (isDrive(hostStr)) { rec.host = ""; setPath(rec, "/" + m); if (base && rec.path.length === 1) rec.path.push(""); } // with a base, Bun adds the trailing slash
      else {
        var host = hostStr === "" ? "" : parseHost(hostStr, true);
        if (host === null) return null;
        rec.host = host === "localhost" ? "" : host;
        setPath(rec, m.slice(e));
      }
      return finish(rec, t, false);
    }
    if (/^[\/\\]/.test(main)) {
      rec.host = base && base.scheme === "file" ? base.host : "";
      if (base && base.scheme === "file" && !isDrive(main.slice(1, 3)) && base.path.length && isDrive(base.path[0]) && base.path[0][1] === ":" && !/^[\/\\][a-zA-Z][:|]/.test(main)) {
        rec.path = [base.path[0]]; addSegments(rec, main.slice(1).split(SLASH_SPECIAL));
      } else setPath(rec, main);
      return finish(rec, t, false);
    }
    if (base && base.scheme === "file") {
      rec.host = base.host; rec.query = base.query;
      if (main === "") { rec.path = base.path.slice(); }
      else {
        rec.query = null;
        rec.path = /^[a-zA-Z][:|]($|[\/\\])/.test(main) ? [] : base.path.slice(0, -1); // a drive letter starts a fresh path
        addSegments(rec, main.split(SLASH_SPECIAL));
      }
      return finish(rec, t, true);
    }
    rec.host = ""; setPath(rec, "/" + main);
    return finish(rec, t, false);
  }
  function parseRelative(input, base) {
    var t = splitTail(input), main = t.main, special = isSpecial(base.scheme), sl = /^[\/\\]/; // Bun also takes a leading backslash as a slash for non-special schemes
    var rec = clone(base);
    if (special ? /^[\/\\]{2}/.test(main) : main.slice(0, 2) === "//") {
      var r = blank(base.scheme), body = main.slice(2);
      if (special) body = body.replace(/^[\/\\]+/, "");
      r = parseAuthority(r, body);
      return r && finish(r, t, false);
    }
    if (sl.test(main)) { setPath(rec, main); return finish(rec, t, false); }
    if (main === "") return finish(rec, t, true);
    rec.path = rec.path.slice(0, -1);
    addSegments(rec, main.split(special ? SLASH_SPECIAL : SLASH_PLAIN));
    return finish(rec, t, false);
  }
  function parse(input, base) {
    input = input.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "").replace(/[\t\n\r]/g, "");
    var m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(input);
    if (m) {
      var scheme = m[1].toLowerCase(), rest = input.slice(m[0].length);
      if (scheme === "file") return parseFile(rest, base && base.scheme === "file" ? base : null);
      var t = splitTail(rest), rec = blank(scheme);
      if (isSpecial(scheme)) {
        if (base && base.scheme === scheme && !/^[\/\\]{2}/.test(t.main)) return parseRelative(rest, base);
        var r = parseAuthority(rec, t.main.replace(/^[\/\\]*/, ""));
        return r && finish(r, t, false);
      }
      if (t.main.slice(0, 2) === "//") { var a = parseAuthority(rec, t.main.slice(2)); if (a) { finish(a, t, false); credQuirk(a); } return a; } // the quirk applies to an absolute string, not to a resolved reference
      if (t.main[0] === "/") { setPath(rec, t.main); return finish(rec, t, false); }
      rec.path = encode(t.main, C0);
      if ((t.query !== null || t.fragment !== null) && rec.path[rec.path.length - 1] === " ") rec.path = rec.path.slice(0, -1) + "%20"; // a space right before ? or # is escaped
      return finish(rec, t, false);
    }
    if (!base) return null;
    if (typeof base.path === "string") {
      if (input[0] !== "#") return null;
      var c = clone(base); c.fragment = encode(input.slice(1), FRAG); return c;
    }
    return base.scheme === "file" ? parseFile(input, base) : parseRelative(input, base);
  }
  function pathname(r) {
    if (typeof r.path === "string") return r.path;
    return r.path.map(function (s) { return "/" + s; }).join("");
  }
  function href(r) {
    var out = r.scheme + ":";
    if (r.host !== null) {
      out += "//";
      if (r.username !== "" || r.password !== "") out += r.username + (r.password !== "" ? ":" + r.password : "") + "@";
      out += r.host + (r.port !== null ? ":" + r.port : "");
    } else if (typeof r.path !== "string" && r.path.length > 1 && r.path[0] === "") out += "/.";
    out += pathname(r);
    if (r.query !== null) out += "?" + r.query;
    if (r.fragment !== null) out += "#" + r.fragment;
    return out;
  }

  // ---- URL --------------------------------------------------------------------------------------------------------
  var urlState = new WeakMap(); // URL -> { rec, params }
  function us(o) { var s = urlState.get(o); if (!s) throw new TypeError("Can only call URL methods on instances of URL"); return s; }
  function invalid(input) { var e = new TypeError(JSON.stringify(input) + " cannot be parsed as a URL."); e.code = "ERR_INVALID_URL"; return e; }
  function resolve(url, base) {
    var b = null;
    if (base !== undefined) { b = parse(usv(base), null); if (b === null) return null; }
    return parse(usv(url), b);
  }
  function syncParams(s) { if (s.params) spState.get(s.params).list = parseForm(s.rec.query || ""); }
  class URL {
    constructor(url, base) {
      if (arguments.length < 1) throw new TypeError("Not enough arguments to URL constructor");
      var rec = resolve(url, base);
      if (rec === null) throw invalid(`${url}`);
      var s = { rec: rec, params: null };
      urlState.set(this, s);
    }
    static canParse(url, base) { if (arguments.length < 1) throw new TypeError("Not enough arguments to URL.canParse"); return resolve(url, base) !== null; }
    static parse(url, base) { if (arguments.length < 1) throw new TypeError("Not enough arguments to URL.parse"); var r = resolve(url, base); if (r === null) return null; var u = Object.create(URL.prototype); urlState.set(u, { rec: r, params: null }); return u; }
    get href() { return href(us(this).rec); }
    set href(v) { var s = us(this), r = parse(usv(v), null); if (r === null) throw invalid(`${v}`); s.rec = r; syncParams(s); }
    get origin() {
      var r = us(this).rec;
      if (isSpecial(r.scheme) && r.scheme !== "file") return r.scheme + "://" + r.host + (r.port !== null ? ":" + r.port : "");
      return "null";
    }
    get protocol() { return us(this).rec.scheme + ":"; }
    set protocol(v) {
      var r = us(this).rec, m = /^([a-zA-Z][a-zA-Z0-9+.\-]*)(:|$)/.exec(usv(v));
      if (!m) return;
      var sc = m[1].toLowerCase();
      if (isSpecial(sc) !== isSpecial(r.scheme)) return;
      if (sc === "file" && (r.username !== "" || r.password !== "" || r.port !== null)) return;
      if (r.scheme === "file" && r.host === "") return;
      r.scheme = sc;
      if (r.port !== null && SPECIAL[sc] === r.port) r.port = null;
    }
    get username() { return us(this).rec.username; }
    set username(v) { var r = us(this).rec; if (r.host === null || r.host === "" || r.scheme === "file") return; r.username = encode(usv(v), USER); }
    get password() { return us(this).rec.password; }
    set password(v) { var r = us(this).rec; if (r.host === null || r.host === "" || r.scheme === "file") return; r.password = encode(usv(v), USER); }
    get host() { var r = us(this).rec; return r.host === null ? "" : r.host + (r.port !== null ? ":" + r.port : ""); }
    set host(v) { setHost(us(this).rec, usv(v), true); }
    get hostname() { var r = us(this).rec; return r.host === null ? "" : r.host; }
    set hostname(v) { setHost(us(this).rec, usv(v), false); }
    get port() { var r = us(this).rec; return r.port === null ? "" : String(r.port); }
    set port(v) {
      var r = us(this).rec; if (r.host === null || r.host === "" || r.scheme === "file") return;
      v = usv(v);
      if (v === "") { r.port = null; return; }
      var m = /^[0-9]+/.exec(v); if (!m) return;
      var n = parseInt(m[0], 10); if (n > 65535) return;
      r.port = SPECIAL[r.scheme] === n ? null : n;
    }
    get pathname() {
      var r = us(this).rec, p = pathname(r);
      // Bun quirk (WebKit): without a host, a non-special path starting "/." loses its first two characters ("web:/.x" has pathname "x")
      if (r.host === null && typeof r.path !== "string" && !isSpecial(r.scheme) && p[0] === "/" && p[1] === ".") return p.slice(2);
      return p;
    }
    set pathname(v) {
      var r = us(this).rec; if (typeof r.path === "string") return;
      v = usv(v).replace(/[\t\n\r]/g, "");
      var special = isSpecial(r.scheme);
      if (v === "" && !special) { r.path = []; return; }
      if (v === "" || !(special ? /^[\/\\]/ : /^\//).test(v)) v = "/" + v;
      setPath(r, v);
    }
    get search() { var q = us(this).rec.query; return q === null || q === "" ? "" : "?" + q; }
    set search(v) {
      var s = us(this), r = s.rec; v = usv(v).replace(/[\t\n\r]/g, "");
      if (v === "") r.query = null;
      else r.query = encode(v[0] === "?" ? v.slice(1) : v, isSpecial(r.scheme) ? SQUERY : QUERY);
      syncParams(s);
    }
    get searchParams() {
      var s = us(this);
      if (!s.params) {
        var p = new URLSearchParams();
        spState.get(p).list = parseForm(s.rec.query || ""); // not the constructor: it would drop a leading "?" that belongs to the query
        spState.get(p).url = function (str) { s.rec.query = str === "" ? null : str; };
        s.params = p;
      }
      return s.params;
    }
    get hash() { var f = us(this).rec.fragment; return f === null || f === "" ? "" : "#" + f; }
    set hash(v) { var r = us(this).rec; v = usv(v).replace(/[\t\n\r]/g, ""); r.fragment = v === "" ? null : encode(v[0] === "#" ? v.slice(1) : v, FRAG); }
    toString() { return href(us(this).rec); }
    toJSON() { return href(us(this).rec); }
  }
  Object.defineProperty(URL.prototype, Symbol.toStringTag, { value: "URL", configurable: true });
  ["username", "password", "host", "hostname", "port", "pathname", "search", "hash", "protocol"].forEach(function (k) { // every setter ends with the credentials quirk
    var d = Object.getOwnPropertyDescriptor(URL.prototype, k), set = d.set;
    d.set = function (v) { set.call(this, v); credQuirk(us(this).rec); };
    Object.defineProperty(URL.prototype, k, d);
  });
  // Bun quirk (WebKit URL): a non-special URL with credentials, a query or fragment and an empty path gets the path "/" (at parse time and when credentials are set)
  function credQuirk(r) { if (!isSpecial(r.scheme) && typeof r.path !== "string" && r.path.length === 0 && (r.username !== "" || r.password !== "") && (r.query !== null || r.fragment !== null)) r.path = [""]; }
  function setHost(r, v, withPort) {
    if (typeof r.path === "string") return;
    var special = isSpecial(r.scheme), end = v.search(special ? /[\/\\?#]/ : /[\/?#]/);
    if (end >= 0) v = v.slice(0, end);
    var hostStr = v, portStr = "";
    if (v[0] === "[") { var rb = v.indexOf("]"); if (rb >= 0 && v[rb + 1] === ":") { hostStr = v.slice(0, rb + 1); portStr = v.slice(rb + 2); } }
    else { var c = v.indexOf(":"); if (c >= 0) { if (!withPort || c === 0 || r.scheme === "file") return; hostStr = v.slice(0, c); portStr = v.slice(c + 1); } }
    if (portStr.indexOf(":") >= 0) return; // a second colon refuses the whole value
    if (portStr !== "" && r.scheme === "file") return; // file URLs have no port
    if (special && /%(?!2[eE])/.test(hostStr) && /[^\u0000-\u007f]/.test(hostStr)) return; // Bun's setters refuse a host with non-ASCII and a percent escape (an escaped dot is fine: observed, not documented)
    if (hostStr === "" && ((special && r.scheme !== "file") || portStr !== "" || r.username !== "" || r.password !== "" || r.port !== null)) return;
    var host = hostStr === "" ? "" : parseHost(hostStr, special);
    if (host === null) return;
    if (r.scheme === "file" && host === "localhost") host = "";
    r.host = host;
    if (withPort) { var m = /^[0-9]+/.exec(portStr); if (m) { var n = parseInt(m[0], 10); if (n <= 65535) r.port = SPECIAL[r.scheme] === n ? null : n; } }
  }

  Object.defineProperty(URLSearchParams, "name", { value: "URLSearchParams", configurable: true }); // a minifier renames the classes
  Object.defineProperty(URL, "name", { value: "URL", configurable: true });
  Object.defineProperty(URL, "length", { value: 1, configurable: true }); // the declared parameter counts of the native ones
  Object.defineProperty(URLSearchParams, "length", { value: 0, configurable: true });
  Object.defineProperty(URL.canParse, "length", { value: 1, configurable: true });
  Object.defineProperty(URL.parse, "length", { value: 1, configurable: true });
  if (needSP) g.URLSearchParams = URLSearchParams;
  if (needURL) g.URL = URL;
})(globalThis);
