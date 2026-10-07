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
  // Bun and Node have `global`; the engine does not. About 4,500 library tests (test scaffolding such as sinon and chai plugins) failed on this alone
  // (tests/real-libs, 65% to 88% of bun's passes). Guarded: an existing `global` is kept.
  if (typeof g.global === "undefined") g.global = g;
  // Needed (measured 2026-10-07, piece removed in a scratch copy): without TextEncoder/TextDecoder tests/effect-core hits the
  // 150 s timeout and the dev-state demo fails its readiness lines. The engine has neither.
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
      // WHATWG UTF-8 decoder: bytes needed / seen, code point so far, lower and upper boundary of the next continuation byte.
      // The state lives across decode(chunk, { stream: true }) calls; a decode without stream flushes it and resets it.
      #fatal;
      #ignoreBOM;
      #need = 0;
      #seen = 0;
      #cp = 0;
      #lo = 128;
      #hi = 191;
      #bomDone = false;
      constructor(label = "utf-8", options = {}) {
        this.#fatal = !!(options && options.fatal);
        this.#ignoreBOM = !!(options && options.ignoreBOM);
      }
      get encoding() {
        return "utf-8";
      }
      get fatal() {
        return this.#fatal;
      }
      get ignoreBOM() {
        return this.#ignoreBOM;
      }
      decode(buf = new Uint8Array(0), options = {}) {
        const b = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const stream = !!(options && options.stream);
        let s = "";
        const bad = () => {
          this.#need = this.#seen = this.#cp = 0;
          this.#lo = 128;
          this.#hi = 191;
          if (this.#fatal) {
            this.#bomDone = false;
            throw new TypeError("The encoded data was not valid for encoding utf-8");
          }
          s += "�";
        };
        const emit = (cp) => {
          if (!this.#bomDone) {
            this.#bomDone = true;
            if (cp === 65279 && !this.#ignoreBOM)
              return;
          }
          s += String.fromCodePoint(cp);
        };
        for (let i = 0;i < b.length; i++) {
          const c = b[i];
          if (this.#need === 0) {
            if (c < 128)
              emit(c);
            else if (c >= 194 && c <= 223) {
              this.#need = 1;
              this.#cp = c & 31;
            } else if (c >= 224 && c <= 239) {
              if (c === 224)
                this.#lo = 160;
              if (c === 237)
                this.#hi = 159;
              this.#need = 2;
              this.#cp = c & 15;
            } else if (c >= 240 && c <= 244) {
              if (c === 240)
                this.#lo = 144;
              if (c === 244)
                this.#hi = 143;
              this.#need = 3;
              this.#cp = c & 7;
            } else
              bad();
            continue;
          }
          if (c < this.#lo || c > this.#hi) {
            bad();
            i--;
            continue;
          }
          this.#lo = 128;
          this.#hi = 191;
          this.#cp = this.#cp << 6 | c & 63;
          if (++this.#seen === this.#need) {
            const cp = this.#cp;
            this.#need = this.#seen = this.#cp = 0;
            emit(cp);
          }
        }
        if (!stream) {
          if (this.#need !== 0)
            bad();
          this.#bomDone = false;
        }
        return s;
      }
    };
  }
  // Needed: AbortSignal extends EventTarget (removing Event/EventTarget alone breaks loading AbortSignal); see the Abort note.
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
  // Needed: without AbortSignal/AbortController tests/effect-core run-modes fails (runFork abort signal) and the bun differential
  // disagrees. DOMException is not here any more: the engine provides it (archived: legacy/polyfills/domexception.2026-10-07.js).
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
  // Needed for speed: no engine test group fails without it, so tests/polyfill asserts it (150 chained setImmediate calls: about
  // 1 ms here, 1630 ms with the engine's own setImmediate; control in tests/polyfill/src/control.ts).
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
  if (!g.__jsbTimerGuard) {
    // The engine's timer wheel starts at 0 and its first update advances it by the whole engine uptime (about
    // 200 ms headless, seconds in a windowed game), so a timer armed in the first frame (_ready of the main scene)
    // that is shorter than that fires at once. Hold timers armed before the first update until it has run.
    // Measured: tests/effect-time. Costs one callback and no per-timer overhead after the first frame.
    g.__jsbTimerGuard = true;
    const nativeSet = g.setTimeout;
    const nativeClear = g.clearTimeout;
    const nativeSetInterval = g.setInterval;
    const nativeClearInterval = g.clearInterval;
    const held = new Set();
    let ready = false;
    nativeSet(() => {
      ready = true;
      const batch = [...held];
      held.clear();
      for (const h of batch)
        h.native = h.start();
    }, 0);
    const guard = (set, clear) => [
      (fn, ms, ...args) => {
        if (ready)
          return set(fn, ms, ...args);
        const h = { native: undefined, start: () => set(fn, ms, ...args) };
        held.add(h);
        return h;
      },
      (h) => {
        if (h !== null && typeof h === "object" && held.has(h))
          held.delete(h);
        else if (h !== null && typeof h === "object" && "start" in h && h.native !== undefined)
          clear(h.native);
        else
          clear(h);
      }
    ];
    [g.setTimeout, g.clearTimeout] = guard(nativeSet, nativeClear);
    [g.setInterval, g.clearInterval] = guard(nativeSetInterval, nativeClearInterval);
  }
  // Needed: without it tests/effect-core (cause, logger, differential) and tests/effect-godot fail, and tests/polyfill checks it.
  if (!g.__jsbStackHeader) {
    g.__jsbStackHeader = true;
    // The wrapper's own frame is the top frame of every stack. It used to be matched by the literal name "Wrapped", but
    // the dev identifier renamer and --minify rename that binding (to "D", "H", ...), which left
    // `at D (polyfills/web-globals.js:314)` on top of every stack. Now the wrapper's name is set explicitly (and
    // Error.name reads right again), so the frame is `at <ctor name> (` whatever the build does to identifiers. Only
    // leading frames are dropped, so a user frame further down is never touched. Measured: tests/polyfill.
    const wrapperFrames = [];
    const fix = (e) => {
      try {
        const st = e.stack;
        if (typeof st === "string" && !/^[A-Za-z_$][\w$]*(: |\n|$)/.test(st)) {
          const head = e.message ? `${e.name}: ${e.message}` : String(e.name);
          const lines = st.split(`
`).filter((l) => !/^\s*at construct \(native\)/.test(l));
          while (lines.length && wrapperFrames.some((n) => lines[0].startsWith("    at " + n + " (")))
            lines.shift();
          const body = lines.join(`
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
      // Wrapped.name is the renamed binding ("D"): a game reading Error.name must still see "Error". The engine reads the
      // function's name when it captures a stack, so after this the wrapper frame reads `at Error (` / `at TypeError (`.
      Object.defineProperty(Wrapped, "name", { value: name, configurable: true });
      wrapperFrames.push(name);
      Wrapped.prototype = Orig.prototype;
      Object.setPrototypeOf(Wrapped, Orig);
      Orig.prototype.constructor = Wrapped;
      Wrapped.__jsbWrapped = true;
      g[name] = Wrapped;
    }
  }
  if (typeof g.console !== "undefined" && !g.console.__jsbConsoleStandIns) {
    // The engine console has log, info, warn, error, debug, trace, time, timeEnd, assert only. Effect's
    // Logger.consolePretty() calls group/groupCollapsed/groupEnd on every line and threw "not a function".
    // Each stand-in is installed only when the method is missing. Measured: tests/effect-core (console-pretty).
    // Not handled: the browser-mode pretty logger prints raw %c and CSS text (the engine console does not
    // interpret %c); use Logger.consolePretty({ mode: "tty", colors: false }) in a game.
    const c = g.console;
    const log = (...args) => c.log(...args);
    const counts = new Map();
    const stand = {
      group: log,
      groupCollapsed: log,
      groupEnd: () => {},
      table: (data) => log(data),
      dir: (obj) => log(obj),
      timeLog: (label = "default", ...rest) => log(`${label}: (timeLog not measured)`, ...rest),
      count: (label = "default") => {
        const n = (counts.get(label) || 0) + 1;
        counts.set(label, n);
        log(`${label}: ${n}`);
      },
      countReset: (label = "default") => {
        counts.delete(label);
      },
      clear: () => {}
    };
    for (const name of Object.keys(stand)) {
      if (typeof c[name] !== "function")
        c[name] = stand[name];
    }
    c.__jsbConsoleStandIns = true;
  }
  // Symbol.dispose / Symbol.asyncDispose (explicit resource management): the engine has neither. Bun's `using` helper falls back to
  // Symbol.for("Symbol.dispose") (it runs before this file), so the registered symbols are used: `using` and [Symbol.dispose] then agree.
  // Difference from Bun, on purpose: Symbol.keyFor(Symbol.dispose) is "Symbol.dispose" here and undefined in Bun (tested by tests/bun-parity).
  if (typeof Symbol.dispose === "undefined") Object.defineProperty(Symbol, "dispose", { value: Symbol.for("Symbol.dispose") });
  if (typeof Symbol.asyncDispose === "undefined") Object.defineProperty(Symbol, "asyncDispose", { value: Symbol.for("Symbol.asyncDispose") });
  // No test needs this (removing it changes no result in effect-core, effect-godot, effect-time, hot-reload, dev-state), but
  // starter/README.md documents crypto.getRandomValues / randomUUID, so it stays until that line is changed on purpose.
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
