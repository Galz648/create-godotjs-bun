(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  function __accessProp(key) {
    return this[key];
  }
  var __toCommonJS = (from) => {
    var entry = (__moduleCache ??= new WeakMap).get(from), desc;
    if (entry)
      return entry;
    entry = __defProp({}, "__esModule", { value: true });
    if (from && typeof from === "object" || typeof from === "function") {
      for (var key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(entry, key))
          __defProp(entry, key, {
            get: __accessProp.bind(from, key),
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
          });
    }
    __moduleCache.set(from, entry);
    return entry;
  };
  var __moduleCache;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined")
      return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });

  // GodotJS/scripts/jsb.runtime/src/jsb.polyfill.ts
  var exports_jsb_polyfill = {};
  var g = globalThis;
  if (typeof g.TextEncoder === "undefined") {
    g.TextEncoder = class TextEncoder {
      get encoding() {
        return "utf-8";
      }
      encode(str = "") {
        const out = [];
        for (const ch of String(str)) {
          const c = ch.codePointAt(0);
          if (c < 128)
            out.push(c);
          else if (c < 2048)
            out.push(192 | c >> 6, 128 | c & 63);
          else if (c < 65536)
            out.push(224 | c >> 12, 128 | c >> 6 & 63, 128 | c & 63);
          else
            out.push(240 | c >> 18, 128 | c >> 12 & 63, 128 | c >> 6 & 63, 128 | c & 63);
        }
        return new Uint8Array(out);
      }
    };
  }
  if (typeof g.TextDecoder === "undefined") {
    g.TextDecoder = class TextDecoder {
      get encoding() {
        return "utf-8";
      }
      decode(buf = new Uint8Array(0)) {
        const b = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        let s = "";
        for (let i = 0;i < b.length; ) {
          const c = b[i++];
          let cp = c;
          if (c >= 240)
            cp = (c & 7) << 18 | (b[i++] & 63) << 12 | (b[i++] & 63) << 6 | b[i++] & 63;
          else if (c >= 224)
            cp = (c & 15) << 12 | (b[i++] & 63) << 6 | b[i++] & 63;
          else if (c >= 192)
            cp = (c & 31) << 6 | b[i++] & 63;
          s += String.fromCodePoint(cp);
        }
        return s;
      }
    };
  }
  if (typeof g.Event === "undefined") {
    g.Event = class Event {
      type;
      defaultPrevented = false;
      target = null;
      currentTarget = null;
      cancelable;
      constructor(type, init) {
        this.type = String(type);
        this.cancelable = !!(init && init.cancelable);
      }
      preventDefault() {
        if (this.cancelable)
          this.defaultPrevented = true;
      }
      stopPropagation() {}
      stopImmediatePropagation() {
        this._stop = true;
      }
    };
  }
  if (typeof g.EventTarget === "undefined") {
    g.EventTarget = class EventTarget {
      _listeners = new Map;
      addEventListener(type, cb, opts) {
        if (!cb)
          return;
        const once = typeof opts === "object" && opts !== null && !!opts.once;
        let list = this._listeners.get(type);
        if (!list) {
          list = [];
          this._listeners.set(type, list);
        }
        if (list.some((l) => l.cb === cb))
          return;
        list.push({ cb, once });
        if (typeof opts === "object" && opts !== null && opts.signal) {
          opts.signal.addEventListener("abort", () => this.removeEventListener(type, cb), { once: true });
        }
      }
      removeEventListener(type, cb) {
        const list = this._listeners.get(type);
        if (!list)
          return;
        const i = list.findIndex((l) => l.cb === cb);
        if (i >= 0)
          list.splice(i, 1);
      }
      dispatchEvent(ev) {
        ev.target = this;
        ev.currentTarget = this;
        const handler = this["on" + ev.type];
        if (typeof handler === "function")
          handler.call(this, ev);
        for (const l of [...this._listeners.get(ev.type) || []]) {
          if (l.once)
            this.removeEventListener(ev.type, l.cb);
          if (typeof l.cb === "function")
            l.cb.call(this, ev);
          else if (l.cb && typeof l.cb.handleEvent === "function")
            l.cb.handleEvent(ev);
          if (ev._stop)
            break;
        }
        return !ev.defaultPrevented;
      }
    };
  }
  if (typeof g.DOMException === "undefined") {
    g.DOMException = class DOMException extends Error {
      constructor(message, name) {
        super(message);
        this.name = name || "Error";
      }
    };
  }
  if (typeof g.AbortSignal === "undefined") {
    const kCreate = Symbol("create");

    class AbortSignal extends g.EventTarget {
      aborted = false;
      reason = undefined;
      onabort = null;
      constructor(key) {
        super();
        if (key !== kCreate)
          throw new TypeError("Illegal constructor");
      }
      throwIfAborted() {
        if (this.aborted)
          throw this.reason;
      }
      _abort(reason) {
        if (this.aborted)
          return;
        this.aborted = true;
        this.reason = reason === undefined ? new g.DOMException("This operation was aborted", "AbortError") : reason;
        this.dispatchEvent(new g.Event("abort"));
      }
      static abort(reason) {
        const s = new AbortSignal(kCreate);
        s._abort(reason);
        return s;
      }
      static timeout(ms) {
        const s = new AbortSignal(kCreate);
        setTimeout(() => s._abort(new g.DOMException("The operation timed out", "TimeoutError")), ms);
        return s;
      }
      static any(signals) {
        const s = new AbortSignal(kCreate);
        for (const sig of signals) {
          if (sig.aborted) {
            s._abort(sig.reason);
            break;
          }
          sig.addEventListener("abort", () => s._abort(sig.reason), { once: true });
        }
        return s;
      }
    }
    g.AbortSignal = AbortSignal;
    g.AbortController = class AbortController {
      signal = new AbortSignal(kCreate);
      abort(reason) {
        this.signal._abort(reason);
      }
    };
  }
  if (!g.__jsbFastImmediate) {
    g.__jsbFastImmediate = true;
    const nativeSetTimeout = g.setTimeout;
    const now = () => typeof g.performance !== "undefined" && g.performance.now ? g.performance.now() : Date.now();
    let queue = [];
    let scheduled = false;
    let chainStart = -1;
    const flush = () => {
      scheduled = false;
      const batch = queue;
      queue = [];
      for (const it of batch) {
        if (!it.cancelled)
          it.fn(...it.args);
      }
      if (queue.length === 0)
        chainStart = -1;
    };
    const schedule = () => {
      if (scheduled)
        return;
      scheduled = true;
      const t = now();
      if (chainStart < 0)
        chainStart = t;
      if (t - chainStart > 4) {
        chainStart = -1;
        nativeSetTimeout(flush, 0);
      } else {
        Promise.resolve().then(flush);
      }
    };
    g.setImmediate = (fn, ...args) => {
      const item = { fn, args, cancelled: false };
      queue.push(item);
      schedule();
      return item;
    };
    g.clearImmediate = (item) => {
      if (item)
        item.cancelled = true;
    };
  }
  if (!g.__jsbStackHeader) {
    g.__jsbStackHeader = true;
    const fix = (e) => {
      try {
        const st = e.stack;
        if (typeof st === "string" && !/^[A-Za-z_$][\w$]*(: |\n|$)/.test(st)) {
          const head = e.message ? `${e.name}: ${e.message}` : String(e.name);
          const body = st.split(`
`).filter((l) => !/^\s*at (construct \(native\)|Wrapped \()/.test(l)).join(`
`);
          e.stack = head + `
` + body;
        }
      } catch {}
      return e;
    };
    for (const name of ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"]) {
      const Orig = g[name];
      if (typeof Orig !== "function" || Orig.__jsbWrapped)
        continue;
      const Wrapped = function(...args) {
        return fix(Reflect.construct(Orig, args, new.target || Wrapped));
      };
      Wrapped.prototype = Orig.prototype;
      Object.setPrototypeOf(Wrapped, Orig);
      Orig.prototype.constructor = Wrapped;
      Wrapped.__jsbWrapped = true;
      g[name] = Wrapped;
    }
  }
  if (typeof g.crypto === "undefined") {
    // Prefer Godot's Crypto (require stays live when `godot` is a bundle external).
    // Math.random is the fallback when Crypto is missing: not secure.
    let godotRandomBytes = null;
    try {
      const godot = (typeof require === "function") ? require("godot") : null;
      if (godot && godot.Crypto) {
        const c = new godot.Crypto;
        godotRandomBytes = (n) => new Uint8Array(c.generate_random_bytes(n).to_array_buffer());
      }
    } catch {}
    const fill = (arr) => {
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      const src = godotRandomBytes ? godotRandomBytes(bytes.length) : null;
      for (let i = 0;i < bytes.length; i++)
        bytes[i] = src ? src[i] : Math.floor(Math.random() * 256);
      return arr;
    };
    g.crypto = {
      getRandomValues: fill,
      randomUUID: () => {
        const b = fill(new Uint8Array(16));
        b[6] = b[6] & 15 | 64;
        b[8] = b[8] & 63 | 128;
        const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      }
    };
  }
})();
