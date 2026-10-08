// Soak probe: sample memory and object counts while a game runs, then assert that each one stops growing.
// Opt-in, for your own tests; Effect not required (a fiber count is just another metric you pass in).
//
//   import { engineMetrics, SoakProbe } from "../src/lib/soak-probe";
//   const probe = new SoakProbe({ ...engineMetrics(), fibers: () => liveFibers });
//   probe.sample(gameMinutes);                        // every N frames, x = game minutes (or swaps, levels...)
//   const verdict = probe.judge({ objects: 20, nodes: 0.5, rss_mb: 4 }, { warmup: 0.25 });
//   for (const line of verdict.lines) console.log(line); // PASS|FAIL soak-<metric> slope=... budget=...
//
// judge() fits a least-squares line through the samples after warm-up (the first `warmup` fraction of x) and fails a
// metric whose slope (units per x) is above its budget. Slopes, not first-vs-last: a sawtooth (GC, pools) averages out,
// a steady leak does not. A budget is an amount per x unit: with x in game minutes, `objects: 20` means "at most 20
// engine objects more per minute of play", 1,200 per hour. Pick budgets from a clean run's slope plus headroom, and
// prove each one with a deliberate leak that must trip it (starter/tests/soak does that for every metric here).
// engineMetrics() reads Performance monitors and `ps` RSS; `rss_mb` is absent where `ps` is unavailable (exports, Windows).
// Design and measured numbers: docs/design/soak.md.

export type Metrics = Record<string, () => number>;
export type Sample = { x: number; values: Record<string, number> };
export type Verdict = { ok: boolean; lines: string[]; slopes: Record<string, number> };

/** Least-squares slope of ys over xs; 0 for fewer than two distinct xs. */
export function slope(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]!; sy += ys[i]!; }
  const mx = sx / n, my = sy / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i]! - mx) * (ys[i]! - my); den += (xs[i]! - mx) ** 2; }
  return den === 0 ? 0 : num / den;
}

export class SoakProbe {
  readonly samples: Sample[] = [];
  constructor(readonly metrics: Metrics) {}

  /** Read every metric now and record it at position x (game minutes, frames, swaps: any increasing unit). */
  sample(x: number): Sample {
    const values: Record<string, number> = {};
    for (const [name, read] of Object.entries(this.metrics)) {
      try { values[name] = read(); } catch { /* a metric that cannot be read now is skipped for this sample */ }
    }
    const s = { x, values };
    this.samples.push(s);
    return s;
  }

  /** Slope per x unit of each metric over the samples after warm-up. */
  slopes(warmup = 0.25): Record<string, number> {
    if (this.samples.length === 0) return {};
    const x0 = this.samples[0]!.x, x1 = this.samples[this.samples.length - 1]!.x;
    const after = this.samples.filter((s) => s.x >= x0 + (x1 - x0) * warmup);
    const out: Record<string, number> = {};
    for (const name of Object.keys(this.metrics)) {
      const pts = after.filter((s) => name in s.values);
      out[name] = slope(pts.map((s) => s.x), pts.map((s) => s.values[name]!));
    }
    return out;
  }

  /** PASS/FAIL per budgeted metric (slope <= budget). Metrics without a budget are reported as INFO lines. */
  judge(budgets: Record<string, number>, opts: { warmup?: number; minSamples?: number; prefix?: string } = {}): Verdict {
    const { warmup = 0.25, minSamples = 8, prefix = "soak" } = opts;
    const slopes = this.slopes(warmup);
    const lines: string[] = [];
    let ok = true;
    if (this.samples.length < minSamples) { ok = false; lines.push(`FAIL ${prefix} only ${this.samples.length} samples (need ${minSamples})`); }
    for (const name of Object.keys(this.metrics)) {
      const s = slopes[name] ?? 0;
      const budget = budgets[name];
      if (budget === undefined) { lines.push(`INFO ${prefix}-${name} slope=${s.toFixed(3)}`); continue; }
      const pass = s <= budget;
      if (!pass) ok = false;
      lines.push(`${pass ? "PASS" : "FAIL"} ${prefix}-${name} slope=${s.toFixed(3)} budget=${budget}`);
    }
    return { ok, lines, slopes };
  }

  /** Tab-separated samples (header first), for a file or the log. */
  table(): string {
    const names = Object.keys(this.metrics);
    return [["x", ...names].join("\t"), ...this.samples.map((s) => [s.x, ...names.map((n) => s.values[n] ?? "")].join("\t"))].join("\n");
  }
}

/** Engine-side metrics: Performance OBJECT_COUNT, static memory (MB), nodes, orphans and process RSS (MB, through `ps`,
 * macOS and Linux only). `godot` is required lazily, so importing this file costs nothing until you call it. */
export function engineMetrics(): Metrics {
  const g = require("godot") as {
    Performance: { get_monitor(m: number): number; has_custom_monitor(id: string): boolean; get_custom_monitor(id: string): number; Monitor: Record<string, number> };
    OS: { get_static_memory_usage(): number; get_process_id(): number; execute(path: string, args: unknown, output: unknown, stderr: boolean): number; get_name(): string };
    GArray: new () => { size(): number; get(i: number): unknown };
    PackedStringArray: new () => { push_back(s: string): void };
  };
  const { Performance, OS, GArray, PackedStringArray } = g;
  const M = Performance.Monitor;
  const out: Metrics = {
    objects: () => Performance.get_monitor(M.OBJECT_COUNT!),
    static_mb: () => OS.get_static_memory_usage() / 1048576,
    nodes: () => Performance.get_monitor(M.OBJECT_NODE_COUNT!),
    orphans: () => Performance.get_monitor(M.OBJECT_ORPHAN_NODE_COUNT!),
  };
  // No JS heap metric on purpose: the engine's GodotJS/* custom monitors append to a Vector on every read that is never
  // cleared, and GodotJS/memory_used_size returns its FIRST value forever (stock binary, docs/design/soak.md). RSS covers the heap.
  if (OS.get_name() === "macOS" || OS.get_name() === "Linux") {
    out.rss_mb = () => {
      // `ps` costs a few ms: sample every few seconds of game time, not every frame.
      const output = new GArray();
      const argv = new PackedStringArray();
      for (const a of ["-o", "rss=", "-p", String(OS.get_process_id())]) argv.push_back(a);
      if (OS.execute("ps", argv, output, true) !== 0 || output.size() === 0) throw new Error("ps failed");
      const kb = Number(String(output.get(0)).trim());
      if (!Number.isFinite(kb) || kb <= 0) throw new Error("ps gave no number");
      return kb / 1024;
    };
  }
  return out;
}
