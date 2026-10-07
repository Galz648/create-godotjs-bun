// OPT-IN polyfill: structuredClone. Import it explicitly:
//   import "../polyfills/structured-clone.js";
// Guarded by `typeof`: a host that already has structuredClone keeps its own.
// Covers: primitives (BigInt, -0, NaN, undefined), boxed primitives, plain objects (own enumerable string keys, prototype dropped),
// arrays (holes and extra keys kept), Map, Set, Date, RegExp (lastIndex reset), ArrayBuffer, typed arrays and DataView (views that share
// a buffer keep sharing the cloned buffer), Error and its native subclasses (message, stack; `cause` is not cloned, as in Bun), cycles and shared references.
// Throws a DOMException named DataCloneError (code 25) for functions, symbols and every other unclonable object (Promise, WeakMap, generators, iterators, Math, JSON, URL, arguments...).
// Iterative (an explicit work list), so deep nesting does not hit the engine's small native stack (QuickJS-ng: about 1000 frames).
// Not covered (see docs/design/bun-parity.md): the `transfer` option (throws DataCloneError), resizable ArrayBuffers, SharedArrayBuffer,
// platform objects such as Blob (they throw here, Bun clones Blob), Proxy (cloned as a plain object here, Bun throws), SharedArrayBuffer, the exact error message text.
(function (g) {
  "use strict";
  if (typeof g.structuredClone !== "undefined") return;

  var toStr = Object.prototype.toString, hasOwn = Object.prototype.hasOwnProperty;
  function dce(msg) {
    if (typeof g.DOMException === "function") return new g.DOMException(msg, "DataCloneError");
    var e = new Error(msg); e.name = "DataCloneError"; e.code = 25; return e;
  }
  // brand checks that a Symbol.toStringTag or a prototype swap cannot fake: call a method that throws on the wrong receiver
  function brand(fn) { return function (v) { try { fn(v); return true; } catch (e) { return false; } }; }
  var isDate = brand(function (v) { Date.prototype.getTime.call(v); });
  var isMap = brand(function (v) { Map.prototype.has.call(v); });
  var isSet = brand(function (v) { Set.prototype.has.call(v); });
  var reGlobal = Object.getOwnPropertyDescriptor(RegExp.prototype, "global").get; // throws on a non-RegExp, undefined on RegExp.prototype
  function isRegExp(v) { try { return typeof reGlobal.call(v) === "boolean"; } catch (e) { return false; } }
  var isBuffer = brand(function (v) { Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get.call(v); });
  var isView = brand(function (v) { Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength").get.call(v); });
  var taTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
  var taNames = { Int8Array: 1, Uint8Array: 1, Uint8ClampedArray: 1, Int16Array: 1, Uint16Array: 1, Int32Array: 1, Uint32Array: 1, Float16Array: 1, Float32Array: 1, Float64Array: 1, BigInt64Array: 1, BigUint64Array: 1 };
  function typedName(v) { var n = taTag.call(v); return n !== undefined && taNames[n] === 1 ? n : undefined; }
  var boxers = [
    ["Number", brand(function (v) { Number.prototype.valueOf.call(v); }), function (v) { return Object(Number.prototype.valueOf.call(v)); }],
    ["String", brand(function (v) { String.prototype.valueOf.call(v); }), function (v) { return Object(String.prototype.valueOf.call(v)); }],
    ["Boolean", brand(function (v) { Boolean.prototype.valueOf.call(v); }), function (v) { return Object(Boolean.prototype.valueOf.call(v)); }],
    ["BigInt", brand(function (v) { BigInt.prototype.valueOf.call(v); }), function (v) { return Object(BigInt.prototype.valueOf.call(v)); }]
  ];
  var errorNames = { Error: 1, EvalError: 1, RangeError: 1, ReferenceError: 1, SyntaxError: 1, TypeError: 1, URIError: 1 };
  function put(o, k, v) { Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true }); }

  function structuredClone(value, options) {
    if (arguments.length < 1) throw new TypeError("The \"value\" argument must be specified");
    if (options !== undefined && options !== null && typeof options === "object") {
      var tr = options.transfer;
      if (tr !== undefined && tr !== null) { var n = 0; for (var t of tr) n++; if (n > 0) throw dce("structuredClone: the transfer option is not supported by this polyfill"); }
    }
    var memory = new Map(), work = [];
    function copy(v) {
      var type = typeof v;
      if (type === "symbol") throw dce("Symbol(" + (v.description === undefined ? "" : v.description) + ") could not be cloned.");
      if (type === "function") throw dce(String(v).slice(0, 60) + " could not be cloned.");
      if (type !== "object" || v === null) return v;
      if (memory.has(v)) return memory.get(v);
      var out, i;
      if (Array.isArray(v)) {
        out = new Array(v.length); memory.set(v, out); work.push(function () { fill(v, out); }); return out;
      }
      if (isDate(v)) { out = new Date(Date.prototype.getTime.call(v)); memory.set(v, out); return out; }
      if (isMap(v)) {
        out = new Map(); memory.set(v, out);
        work.push(function () { var entries = []; Map.prototype.forEach.call(v, function (val, key) { entries.push([key, val]); }); for (var j = 0; j < entries.length; j++) Map.prototype.set.call(out, copy(entries[j][0]), copy(entries[j][1])); });
        return out;
      }
      if (isSet(v)) {
        out = new Set(); memory.set(v, out);
        work.push(function () { var items = []; Set.prototype.forEach.call(v, function (val) { items.push(val); }); for (var j = 0; j < items.length; j++) Set.prototype.add.call(out, copy(items[j])); });
        return out;
      }
      if (isBuffer(v)) { out = v.slice(0); memory.set(v, out); return out; }
      if (isView(v)) {
        var b = copy(v.buffer); out = new DataView(b, v.byteOffset, v.byteLength); memory.set(v, out); return out;
      }
      var tn = typedName(v);
      if (tn !== undefined) {
        var tb = copy(v.buffer); out = new g[tn](tb, v.byteOffset, v.length); memory.set(v, out); return out;
      }
      if (isRegExp(v)) { out = new RegExp(v.source, v.flags); memory.set(v, out); return out; }
      for (i = 0; i < boxers.length; i++) if (boxers[i][1](v)) { out = boxers[i][2](v); memory.set(v, out); return out; }
      if (typeof g.DOMException === "function" && v instanceof g.DOMException) { out = new g.DOMException(v.message, v.name); memory.set(v, out); return out; }
      if (toStr.call(v) === "[object Error]" && !hasOwn.call(v, Symbol.toStringTag)) {
        var name = v.name; if (errorNames[name] !== 1) name = "Error";
        var md = Object.getOwnPropertyDescriptor(v, "message"), msg = md && "value" in md ? String(md.value) : undefined;
        out = new g[name](msg);
        if (msg === undefined && hasOwn.call(out, "message")) delete out.message;
        memory.set(v, out);
        var sd = Object.getOwnPropertyDescriptor(v, "stack");
        if (sd && typeof sd.value === "string") Object.defineProperty(out, "stack", { value: sd.value, writable: true, enumerable: false, configurable: true });
        else delete out.stack;
        return out;
      }
      if (isUnclonable(v)) throw dce("#<Object> could not be cloned.");
      out = {}; memory.set(v, out); work.push(function () { fill(v, out); }); return out;
    }
    // what is left after every clonable kind: a built-in or platform object (Promise, WeakMap, generators, iterators, Math, JSON, URL,
    // arguments...) is told by a Symbol.toStringTag or class tag that is not an enumerable property of its own; a plain object
    // (even one with an enumerable Symbol.toStringTag of its own) is cloned. The three prototypes below have the plain tag.
    function isUnclonable(v) {
      var tag = toStr.call(v);
      if (tag === "[object Object]") return v === Error.prototype || v === Date.prototype || v === RegExp.prototype;
      var d = Object.getOwnPropertyDescriptor(v, Symbol.toStringTag);
      return !(d && d.enumerable);
    }
    function fill(src, dst) {
      var keys = Object.keys(src);
      for (var j = 0; j < keys.length; j++) {
        var k = keys[j];
        if (!Object.prototype.propertyIsEnumerable.call(src, k)) continue;
        put(dst, k, copy(src[k]));
      }
    }
    var result = copy(value);
    for (var w = 0; w < work.length; w++) work[w]();
    return result;
  }
  Object.defineProperty(structuredClone, "name", { value: "structuredClone", configurable: true }); // a minifier renames the function
  Object.defineProperty(g, "structuredClone", { value: structuredClone, writable: true, enumerable: true, configurable: true });
})(globalThis);
