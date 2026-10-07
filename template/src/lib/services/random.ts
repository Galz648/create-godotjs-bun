// Game services kit: a seeded, deterministic Random. OPT-IN, Effect projects only (like game-clock.ts: not in
// tools/toolchain-files.json, removed by create-godotjs-bun --no-effect). Imports Effect by subpath. Needs no engine API,
// so it runs under plain `bun test`. Tested by starter/tests/effect-services (logic.test.ts and the engine scene).
//
// Rules this encodes:
//  1. NEVER use Math.random in game logic: a replay, a save or a failing test cannot reproduce it. Take a Random.
//  2. One seed -> one sequence, on every platform (sfc32 over 32-bit integer math: no float rounding, no engine call).
//  3. `fork(label)` gives an independent stream derived from the ORIGINAL seed and the label, not from how many numbers
//     the parent has drawn: adding a draw in the loot system does not change the map generator. Use one fork per system.
//  4. `state` / `restore` capture the whole generator (words + seed key), so a save holds `RandomState` (a Schema is
//     exported) and a loaded game continues the exact sequence.
//  5. Effect's own `Random` reference stays untouched; this is the service named `game.Random`.
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class EmptyChoice extends Data.TaggedError("EmptyChoice")<{ readonly what: string }> {}

/** The serialisable generator state: store it in a save file. */
export const RandomState = Schema.Struct({ seed: Schema.String, words: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]) });
export type RandomState = typeof RandomState.Type;

// xmur3-style string hash, four 32-bit words.
function hashWords(text: string): [number, number, number, number] {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const next = () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
  return [next(), next(), next(), next()];
}

/** The plain synchronous generator (sfc32). Use it directly in hot per-entity code; the service wraps one of these. */
export class Rng {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;
  seedKey: string;
  constructor(seedKey: string) {
    this.seedKey = seedKey;
    [this.a, this.b, this.c, this.d] = hashWords(seedKey);
    for (let i = 0; i < 15; i++) this.next(); // sfc32's recommended warm-up
  }
  /** A number in [0, 1). */
  next(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }
  /** An integer in [min, max], both included. */
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) throw new RangeError(`Random.int(${min}, ${max}): need integers with min <= max`);
    return min + Math.floor(this.next() * (max - min + 1));
  }
  shuffle<A>(items: Iterable<A>): A[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
  state(): RandomState {
    return { seed: this.seedKey, words: [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0] };
  }
  /** Replace the generator state (including the seed key forks derive from). */
  restore(s: RandomState): void {
    this.seedKey = s.seed;
    this.a = s.words[0] | 0;
    this.b = s.words[1] | 0;
    this.c = s.words[2] | 0;
    this.d = s.words[3] | 0;
  }
  fork(label: string | number): Rng {
    return new Rng(`${this.seedKey}/${label}`);
  }
}

export interface RandomShape {
  /** A number in [0, 1). */
  readonly next: Effect.Effect<number>;
  /** An integer in [min, max], both included. Bad bounds (not integers, min > max) are a defect (RangeError). */
  readonly int: (min: number, max: number) => Effect.Effect<number>;
  /** True with probability p. */
  readonly chance: (p: number) => Effect.Effect<boolean>;
  /** One element; fails with EmptyChoice on an empty list. */
  readonly pick: <A>(items: readonly A[]) => Effect.Effect<A, EmptyChoice>;
  /** A shuffled copy (Fisher-Yates); the input is not changed. */
  readonly shuffle: <A>(items: Iterable<A>) => Effect.Effect<A[]>;
  /** An independent generator derived from the original seed and `label` (see rule 3). */
  readonly fork: (label: string | number) => Effect.Effect<RandomShape>;
  readonly state: Effect.Effect<RandomState>;
  readonly restore: (state: RandomState) => Effect.Effect<void>;
}

export const makeRandom = (rng: Rng): RandomShape => ({
  next: Effect.sync(() => rng.next()),
  int: (min, max) => Effect.sync(() => rng.int(min, max)),
  chance: (p) => Effect.sync(() => rng.next() < p),
  pick: (items) => (items.length === 0 ? Effect.fail(new EmptyChoice({ what: "pick" })) : Effect.sync(() => items[rng.int(0, items.length - 1)]!)),
  shuffle: (items) => Effect.sync(() => rng.shuffle(items)),
  fork: (label) => Effect.sync(() => makeRandom(rng.fork(label))),
  state: Effect.sync(() => rng.state()),
  restore: (s) => Effect.sync(() => rng.restore(s)),
});

export class Random extends Context.Service<Random, RandomShape>()("game.Random") {
  /** A Random from a seed (a number or any string). Same seed, same sequence. */
  static layer = (seed: number | string): Layer.Layer<Random> => Layer.sync(Random, () => makeRandom(new Rng(String(seed))));
  /** Same as `layer`: the generator has no engine dependency, so the test Layer is the live one (use a fixed seed). */
  static testLayer = (seed: number | string = 1): Layer.Layer<Random> => Random.layer(seed);
}
