// OPT-IN polyfill: accurate long timers. Import it explicitly, AFTER polyfills/web-globals.js:
//   import "../polyfills/timer-accuracy.js";
// Why: the engine's timer wheel runs about 3% slow at 60 fps (up to 9% uncapped) because GodotJSScriptLanguage::frame() feeds it whole
// milliseconds and drops the sub-millisecond remainder of every frame, so setTimeout / setInterval / Effect.sleep fire late
// (issue 10, docs/design/effect-time.md). This file wraps setTimeout / setInterval / clearTimeout / clearInterval:
//   - a timer of 40 ms or more is armed on the wheel for (wanted wall ms) / ratio, ratio being the measured wall ms per wheel ms
//     (a decaying sum of wall / wheel over the fired timers, weighted by length);
//   - when the wheel fires it early (it may, by up to one 10 ms jiffy) the remainder is re-armed: a timer never fires before its time,
//     by performance.now(), measured from the moment setTimeout was called;
//   - every due timer runs in due order (then arming order) in one batch, so two timers that land on the same wheel ms keep their order;
//   - setInterval of 40 ms or more runs on a fixed grid (no accumulated drift); a missed beat is skipped, never replayed (as the wheel);
//   - timers under 40 ms, and anything that is not a function callback, go straight to the previous setTimeout / setInterval.
// Costs: about 1 object and 1 closure per timer, one extra native timer when a fire lands early, nothing per frame. The handle is a
// small object (like the first-frame guard's): clearTimeout / clearInterval take it (either of the two clears either kind), and
// handles of the previous implementation still work. If the engine's wheel is fixed (ratio 1) the correction vanishes by itself.
// Not changed: callbacks still run at a frame start (up to one frame late), the game clock (src/lib/game-clock.ts) is still the tool
// for frame-accurate and pausable time. Tested: starter/tests/timer-accuracy (engine) and starter/tests/timer-accuracy/semantics.test.ts (bun).
(() => {
  const g = globalThis;
  if (g.__jsbTimerAccuracy || typeof g.setTimeout !== "function") return;
  const MIN_MS = 40;
  const prevSet = g.setTimeout;
  const prevClear = g.clearTimeout;
  const prevSetInterval = g.setInterval;
  const prevClearInterval = g.clearInterval;
  const now = () => (g.performance && typeof g.performance.now === "function" ? g.performance.now() : Date.now());

  // Wall ms per wheel ms, from a calibration timer of CAL_MS that re-arms itself. A callback only runs at a frame start, so every
  // sample is the true ratio plus a positive error (up to one frame over CAL_MS); the smallest of the last few samples is the best
  // estimate. Aiming a little late costs less than aiming early (an early fire needs a re-arm, which waits for the next frame).
  const CAL_MS = 1000;
  const CAL_KEEP = 5;
  const samples = [];
  const ratio = () => (samples.length ? Math.min(1.25, Math.max(0.95, Math.min(...samples))) : 1);
  const calibrate = () => {
    const t0 = now();
    prevSet(() => {
      const r = (now() - t0) / CAL_MS;
      if (r > 0) {
        samples.push(r);
        if (samples.length > CAL_KEEP) samples.shift();
      }
      calibrate();
    }, CAL_MS);
  };
  calibrate();

  let seq = 0;
  let rearms = 0;
  const live = new Set(); // handles that are armed and not done
  const arm = (h, nowMs) => {
    const native = Math.max(1, Math.round((h.due - nowMs) / ratio()));
    h.native = prevSet(onNative, native, h, ++h.gen);
  };
  // clear the wheel's timer only while it is pending (clearing one that fired makes the engine log "timer active (invalid)")
  const dropNative = (h) => {
    if (h.native !== undefined) prevClear(h.native);
    h.native = undefined;
    h.gen++;
  };
  function onNative(h, gen) {
    if (gen !== h.gen || h.done || h.cleared) return; // a stale native timer (its handle was drained by an earlier fire or re-armed)
    h.native = undefined; // this one has fired
    const n = now();
    if (n < h.due) { // the wheel fired early (jiffy): never early, re-arm the rest
      h.rearmed = true;
      rearms++;
      h.native = prevSet(onNative, Math.max(1, Math.ceil((h.due - n) / ratio())), h, ++h.gen);
      return;
    }
    h.rearmed = false;
    drain(n);
  }
  const drain = (n) => {
    const batch = [];
    for (const h of live) if (h.due <= n) batch.push(h);
    batch.sort((a, b) => a.due - b.due || a.seq - b.seq);
    let failed = false;
    let error;
    for (const h of batch) {
      if (h.cleared || h.done || !live.has(h)) continue;
      if (h.interval > 0) {
        // fixed grid, skip beats that were missed (the wheel does not replay them either)
        const k = Math.floor((n - h.due) / h.interval) + 1;
        h.due += k * h.interval;
        h.native = undefined; // never clear here: that timer may have fired in this frame already (the engine logs a clear of a dead timer)
        h.rearmed = false;
        arm(h, n);
      } else {
        h.done = true;
        live.delete(h);
        h.gen++; // a native timer of a handle drained early stays on the wheel and no-ops when it fires
      }
      try {
        h.fn(...h.args);
      } catch (e) {
        if (!failed) { failed = true; error = e; } else prevSet(() => { throw e; }, 0);
      }
    }
    if (failed) throw error;
  };

  class AccurateTimer {
    constructor(fn, ms, args, interval) {
      this.fn = fn;
      this.args = args;
      this.interval = interval ? ms : 0;
      this.seq = ++seq;
      this.cleared = false;
      this.done = false;
      this.rearmed = false;
      this.native = undefined;
      this.gen = 0;
      this.due = 0;
      this.id = this.seq;
      this.wantMs = ms;
      this.refd = true;
    }
    start() {
      const n = now();
      this.due = n + this.wantMs;
      live.add(this);
      arm(this, n);
    }
    cancel() {
      this.cleared = true;
      live.delete(this);
      dropNative(this);
    }
    ref() { this.refd = true; return this; }
    unref() { this.refd = false; return this; }
    hasRef() { return this.refd; }
    refresh() {
      if (!this.cleared && !this.done) {
        dropNative(this);
        this.rearmed = false;
        this.start();
      }
      return this;
    }
    [Symbol.toPrimitive]() { return this.id; }
  }

  const make = (interval, prev) => (fn, ms, ...args) => {
    const want = Number(ms);
    if (typeof fn !== "function" || !(want >= MIN_MS) || want === Infinity) return prev(fn, ms, ...args);
    const h = new AccurateTimer(fn, want, args, interval);
    h.start();
    return h;
  };
  const clear = (prev) => (h) => {
    if (h instanceof AccurateTimer) h.cancel();
    else prev(h);
  };
  g.setTimeout = make(false, prevSet);
  g.setInterval = make(true, prevSetInterval);
  g.clearTimeout = clear(prevClear);
  g.clearInterval = clear(prevClearInterval);
  g.__jsbTimerAccuracy = { ratio, pending: () => live.size, rearms: () => rearms };
})();
