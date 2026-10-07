// Game services kit: Assets, ResourceLoader as an Effect with a cache. OPT-IN, Effect projects only (not in
// tools/toolchain-files.json, removed by create-godotjs-bun --no-effect). Imports Effect by subpath.
// Tested by starter/tests/effect-services (logic.test.ts with a fake loader and TestClock, the engine scene with the real one).
//
//   const assets = yield* Assets;
//   const sheet = yield* assets.load<Texture2D>("res://hero.png");                // synchronous load, cached
//   const level = yield* assets.loadThreaded<PackedScene>("res://level1.tscn");   // threaded, polled; interrupt-safe
//   yield* assets.preload(["res://a.png", "res://b.png"]);                         // all at once
//   yield* assets.release("res://hero.png");                                       // drop OUR reference
//   // missing path: fails with AssetNotFound, and the engine prints NOTHING (see rule 1)
//
// Rules this encodes (measured in starter/tests/effect-primitives group 6):
//  1. A missing path is checked with ResourceLoader.exists FIRST and fails with `AssetNotFound`. Asking the threaded loader
//     for a missing path returns OK from the request, reports FAILED 200 ms later and the loader THREAD prints two engine
//     ERROR lines ("Cannot open file", "Failed loading resource"): never let it get that far.
//  2. A threaded load that is never taken leaks ("ObjectDB instances leaked at exit"). When the waiting fiber is interrupted
//     (a timeout, a scene change), a detached fiber keeps polling and TAKES the result (`load_threaded_get`) once it is
//     LOADED, so 0 requests stay pending. The interrupt itself returns at once (a timeout stays a timeout).
//  3. Polling uses the ambient Clock every `pollMs` (default 16, about a frame). With the game clock provided, loading polls only
//     while the tree runs; with TestClock, a test advances time to step the load.
//  4. The cache keeps one reference per path: loads of the same path are serialised per path, so two fibers asking for the
//     same asset make ONE request and the second gets the cached value. `release` drops the cache entry; the resource is freed
//     when nothing else holds it (a RefCounted is freed a frame after the last JS reference goes).
//  5. The type argument of `load<A>` is a promise, not a check (the loader returns whatever the file is).
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { godot } from "./engine";

export class AssetNotFound extends Data.TaggedError("AssetNotFound")<{ readonly path: string }> {}
/** The file exists but did not load (corrupt, wrong type, the loader FAILED or lost the request). `reason` names the engine state. */
export class AssetLoadFailed extends Data.TaggedError("AssetLoadFailed")<{ readonly path: string; readonly reason: string }> {}
export type AssetError = AssetNotFound | AssetLoadFailed;

/** The loader as the service sees it. The live one is ResourceLoader; tests use `fakeLoader`. */
export interface AssetLoader {
  exists(path: string, typeHint?: string): boolean;
  /** The resource, or null/undefined when it could not be loaded. */
  load(path: string, typeHint?: string): unknown;
  /** 0 = OK. */
  request(path: string, typeHint?: string): number;
  /** 0 invalid (no request), 1 in progress, 2 failed, 3 loaded. */
  status(path: string): number;
  /** Take the result of a LOADED (or FAILED) request: the request is cleared. */
  take(path: string): unknown;
}

export const resourceLoader = (engine: ReturnType<typeof godot> = godot()): AssetLoader => ({
  exists: (p, h) => engine.ResourceLoader.exists(p, h),
  load: (p, h) => engine.ResourceLoader.load(p, h),
  request: (p, h) => engine.ResourceLoader.load_threaded_request(p, h),
  status: (p) => engine.ResourceLoader.load_threaded_get_status(p),
  take: (p) => engine.ResourceLoader.load_threaded_get(p),
});

export interface AssetsShape {
  readonly load: <A = unknown>(path: string, typeHint?: string) => Effect.Effect<A, AssetError>;
  readonly loadThreaded: <A = unknown>(path: string, typeHint?: string) => Effect.Effect<A, AssetError>;
  /** loadThreaded of every path, all requested at once; results in the order of `paths`. */
  readonly preload: (paths: readonly string[]) => Effect.Effect<unknown[], AssetError>;
  readonly cached: (path: string) => Effect.Effect<boolean>;
  readonly release: (path: string) => Effect.Effect<void>;
  readonly releaseAll: Effect.Effect<void>;
  readonly size: Effect.Effect<number>;
}

export const makeAssets = (loader: AssetLoader, options: { readonly pollMs?: number } = {}): AssetsShape => {
  const pollMs = options.pollMs ?? 16;
  const cache = new Map<string, unknown>();
  const locks = new Map<string, Semaphore.Semaphore>();
  const locked = <A, E>(path: string, self: Effect.Effect<A, E>): Effect.Effect<A, E> => {
    let lock = locks.get(path);
    if (!lock) locks.set(path, (lock = Semaphore.makeUnsafe(1)));
    return lock.withPermits(1)(self);
  };
  const wait = Effect.sleep(Duration.millis(pollMs));

  /** Keep polling a request nobody waits for any more and take its result (rule 2). */
  const draining = new Set<string>();
  const drainLoop = (path: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const st = loader.status(path);
      if (st === 1) return wait.pipe(Effect.andThen(drainLoop(path)));
      if (st === 3 || st === 2) loader.take(path);
      return Effect.void;
    });
  const drain = (path: string): Effect.Effect<void> =>
    Effect.sync(() => void draining.add(path)).pipe(Effect.andThen(drainLoop(path)), Effect.ensuring(Effect.sync(() => void draining.delete(path))));
  /** A new request for a path must not start while a detached drain still owns the old one (they would share one result). */
  const drained = (path: string): Effect.Effect<void> => Effect.suspend(() => (draining.has(path) ? wait.pipe(Effect.andThen(drained(path))) : Effect.void));

  const check = (path: string, typeHint?: string): Effect.Effect<void, AssetNotFound> =>
    Effect.suspend(() => (loader.exists(path, typeHint) ? Effect.void : Effect.fail(new AssetNotFound({ path }))));

  const store = (path: string, res: unknown, what: string): Effect.Effect<unknown, AssetLoadFailed> =>
    res === null || res === undefined ? Effect.fail(new AssetLoadFailed({ path, reason: what })) : Effect.sync(() => (cache.set(path, res), res));

  const load = <A = unknown>(path: string, typeHint?: string): Effect.Effect<A, AssetError> =>
    locked(
      path,
      Effect.suspend((): Effect.Effect<unknown, AssetError> => {
        if (cache.has(path)) return Effect.succeed(cache.get(path));
        return check(path, typeHint).pipe(Effect.andThen(Effect.suspend(() => store(path, loader.load(path, typeHint), "load returned null"))));
      }),
    ) as Effect.Effect<A, AssetError>;

  const loadThreaded = <A = unknown>(path: string, typeHint?: string): Effect.Effect<A, AssetError> =>
    locked(
      path,
      Effect.suspend((): Effect.Effect<unknown, AssetError> => {
        if (cache.has(path)) return Effect.succeed(cache.get(path));
        return check(path, typeHint).pipe(
          Effect.andThen(drained(path)),
          Effect.andThen(
            Effect.suspend((): Effect.Effect<unknown, AssetError> => {
              const code = loader.request(path, typeHint);
              if (code !== 0) return Effect.fail(new AssetLoadFailed({ path, reason: `request error ${code}` }));
              const poll: Effect.Effect<unknown, AssetError> = Effect.suspend(() => {
                const st = loader.status(path);
                if (st === 1) return wait.pipe(Effect.andThen(poll));
                if (st === 3) return Effect.suspend(() => store(path, loader.take(path), "load_threaded_get returned null"));
                if (st === 2) {
                  loader.take(path);
                  return Effect.fail(new AssetLoadFailed({ path, reason: "threaded load FAILED" }));
                }
                return Effect.fail(new AssetLoadFailed({ path, reason: `status ${st} (the request was lost)` }));
              });
              return poll.pipe(Effect.onInterrupt(() => Effect.forkDetach(drain(path)).pipe(Effect.asVoid)));
            }),
          ),
        );
      }),
    ) as Effect.Effect<A, AssetError>;

  return {
    load,
    loadThreaded,
    preload: (paths) => Effect.forEach(paths, (p) => loadThreaded(p), { concurrency: "unbounded" }),
    cached: (path) => Effect.sync(() => cache.has(path)),
    release: (path) => Effect.sync(() => void cache.delete(path)),
    releaseAll: Effect.sync(() => cache.clear()),
    size: Effect.sync(() => cache.size),
  };
};

/** A scripted loader for tests. `files` maps a path to the value `load` returns; `broken` paths exist but fail to load. */
export interface FakeLoader extends AssetLoader {
  /** Every call, in order, as "op path". */
  readonly calls: string[];
  /** Requests made and not yet taken: must be empty when a test ends (the leak the engine would report at exit). */
  readonly pending: Set<string>;
}
export const fakeLoader = (files: Record<string, unknown>, options: { readonly polls?: number; readonly broken?: readonly string[] } = {}): FakeLoader => {
  const polls = options.polls ?? 2;
  const broken = new Set(options.broken ?? []);
  const left = new Map<string, number>();
  const calls: string[] = [];
  const pending = new Set<string>();
  const known = (p: string) => Object.hasOwn(files, p) || broken.has(p);
  return {
    calls,
    pending,
    exists: (p) => (calls.push(`exists ${p}`), known(p)),
    load: (p) => (calls.push(`load ${p}`), broken.has(p) ? null : files[p]),
    request: (p) => {
      calls.push(`request ${p}`);
      if (!known(p)) calls.push(`ENGINE-ERRORS ${p}`); // what the real loader thread would print
      pending.add(p);
      left.set(p, polls);
      return 0;
    },
    status: (p) => {
      calls.push(`status ${p}`);
      if (!pending.has(p)) return 0;
      const n = left.get(p)!;
      if (n > 0) {
        left.set(p, n - 1);
        return 1;
      }
      return broken.has(p) || !known(p) ? 2 : 3;
    },
    take: (p) => {
      calls.push(`take ${p}`);
      pending.delete(p);
      return broken.has(p) ? null : files[p];
    },
  };
};

export class Assets extends Context.Service<Assets, AssetsShape>()("game.Assets") {
  /** Live: ResourceLoader. */
  static layer = (options: { readonly pollMs?: number } = {}): Layer.Layer<Assets> => Layer.sync(Assets, () => makeAssets(resourceLoader(), options));
  /** Test: a scripted loader (`fakeLoader({...})` keeps the call log and the pending set for assertions). */
  static testLayer = (loader: AssetLoader, options: { readonly pollMs?: number } = {}): Layer.Layer<Assets> => Layer.sync(Assets, () => makeAssets(loader, options));
}
