// Glue between Effect and Godot nodes. OPT-IN, Effect projects only: imports `godot` and `effect`, is NOT in
// tools/toolchain-files.json and create-godotjs-bun --no-effect deletes it (like game-clock.ts).
// Tested by starter/tests/effect-godot (and starter/tests/effect-time for the clock). Rules: starter/docs/DAILY.md.
// Everything uses explicit Callable.create so it behaves the same with or without the build plugin.
// Callable.create(fn) twice with the same fn compares equal, so disconnect(Callable.create(fn)) finds the connection.
import { Callable, is_instance_valid } from "godot";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

type Sig = { connect(c: any, flags?: number): any; disconnect(c: any): void; is_connected(c: any): boolean; get_object(): any };
type Anyfn = (...args: any[]) => void;

/**
 * Connect `fn` to a signal; returns a disconnect function that is safe to call twice or after the emitter died.
 * `oneShot`: the engine drops the connection itself before the first call.
 * Ticket 300: a handler that can reach its own Callable (here: `fn` calls the returned function, which holds the Callable)
 * is a reference cycle THROUGH the engine (JS Callable -> engine Callable -> JS function -> ... -> JS Callable) that QuickJS
 * cannot collect: about 0.5 KB static plus everything the closure holds, forever, per connection (stock engine; measured by
 * starter/tests/soak scene probe.tscn). So the Callable is dropped as soon as it is no longer needed: on disconnect, and
 * for `oneShot` at the first call. A handler that disconnects itself should use `oneShot`.
 */
export function connectSignal(sig: Sig, fn: Anyfn, oneShot = false): () => void {
  let c: Callable | null = Callable.create(oneShot ? (...a: any[]) => { c = null; fn(...a); } : fn);
  sig.connect(c, oneShot ? 4 /* Object.CONNECT_ONE_SHOT */ : 0);
  return () => {
    const mine = c;
    if (mine === null) return;
    c = null;
    // is_connected on a freed emitter logs an engine ERROR ("Parameter obj is null") even inside try/catch: ask first.
    if (is_instance_valid(sig.get_object()) && sig.is_connected(mine)) sig.disconnect(mine);
  };
}

/** queue_free that tolerates a node that is already gone (calling a method on a freed Object throws "Bad this"). */
export const freeNode = (node: { queue_free(): void }): void => {
  if (is_instance_valid(node)) node.queue_free();
};

const pack = (a: unknown[]) => (a.length <= 1 ? a[0] : a);

/** A signal as an Effect: succeeds with the first emission (args array when there are several). Interruption disconnects. */
export const signalOnce = <A = unknown>(sig: Sig): Effect.Effect<A> =>
  Effect.callback<A>((resume) => {
    let off = () => {};
    off = connectSignal(sig, (...a) => {
      off(); // a no-op: the one-shot connection is already gone (disconnecting here would leak, ticket 300)
      resume(Effect.succeed(pack(a) as A));
    }, true);
    return Effect.sync(off);
  });

/** A signal as a Stream: one element per emission. The finalizer (end, take, interruption) disconnects. */
export const signalStream = <A = unknown>(sig: Sig): Stream.Stream<A> =>
  Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => connectSignal(sig, (...a) => void Queue.offerUnsafe(queue, pack(a) as A))),
      (off) => Effect.sync(off),
    ),
  );

/**
 * A Scope tied to a node: when the node emits `tree_exiting` (leaves the tree, which includes queue_free) the scope
 * closes: finalizers run, and fibers started with `forkOnNode` are interrupted. Close is idempotent.
 * `disconnect` detaches the tree_exiting hook (the node outlives its owner).
 */
export interface NodeScope {
  readonly scope: Scope.Closeable;
  readonly closed: () => boolean;
  /** Close now (same as the node leaving). Resolves when all finalizers ran. */
  readonly close: () => Promise<void>;
}

export function nodeScope(node: { tree_exiting: Sig }): NodeScope {
  // Not Effect.runSync(Scope.make()): every runSync of a non-trivial effect keeps about 0.8 KB on QuickJS (ticket 301).
  const scope = Scope.makeUnsafe();
  let isClosed = false;
  let pending: Promise<void> | undefined;
  const close = () => {
    if (!isClosed) {
      isClosed = true;
      off();
      pending = Effect.runPromise(Scope.close(scope, Exit.void));
    }
    return pending!;
  };
  // One-shot: close() runs inside the tree_exiting emission, and its off() must not disconnect there (ticket 300).
  const off = connectSignal(node.tree_exiting, () => void close(), true);
  return { scope, closed: () => isClosed, close };
}

/** Run an effect as a fiber owned by the node: interrupted (and its scoped resources released) when the node exits. */
export function forkOnNode<A, E>(ns: NodeScope, eff: Effect.Effect<A, E, Scope.Scope>): Fiber.Fiber<A, E> {
  const fiber = Effect.runFork(Effect.provideService(eff, Scope.Scope, ns.scope) as Effect.Effect<A, E>);
  // Interrupt first (finalizers run last-added-first), then release what the fiber acquired in the scope.
  // runFork, not runSync (ticket 301): adding a finalizer is synchronous, so the fiber completes inside this call.
  Effect.runFork(Scope.addFinalizer(ns.scope, Fiber.interrupt(fiber)));
  return fiber;
}

/**
 * Per-node frame driver. The node forwards its engine callbacks:
 *   _process(d) { this.frames.process(d) }   _physics_process(d) { this.frames.physics(d) }
 * Fibers then wait on `processStream` / `physicsStream` / `nextProcess` and never touch the tree.
 */
export class Frames {
  private pl = new Set<(d: number) => void>();
  private yl = new Set<(d: number) => void>();
  process(d: number) { for (const f of [...this.pl]) f(d); }
  physics(d: number) { for (const f of [...this.yl]) f(d); }
  get listeners() { return this.pl.size + this.yl.size; }
  private stream(set: Set<(d: number) => void>): Stream.Stream<number> {
    return Stream.callback<number>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const f = (d: number) => void Queue.offerUnsafe(queue, d);
          set.add(f);
          return f;
        }),
        (f) => Effect.sync(() => void set.delete(f)),
      ),
    );
  }
  get processStream() { return this.stream(this.pl); }
  get physicsStream() { return this.stream(this.yl); }
  nextProcess = Effect.callback<number>((resume) => {
    const f = (d: number) => { this.pl.delete(f); resume(Effect.succeed(d)); };
    this.pl.add(f);
    return Effect.sync(() => void this.pl.delete(f));
  });
}

/**
 * Failure reporting. Stock behaviour (measured, see NOTES.md): an unhandled `Effect.runPromise` rejection prints only
 * `unhandled promise rejection: <String(reason)>` (no stack; a TaggedError shows just its name) and a failing `runFork`
 * prints nothing at all. These two print the full pretty cause (message, stack with .js:line:col that
 * tools/unmap.ts maps to .ts:line) and keep the stock result shape. They print with console.log and an `ERROR ` prefix
 * (no colon: console.error makes the engine add a garbage `at:  (:0)` line and an `ERROR:` line that trips the log lint).
 */
const report = (label: string) => (cause: Cause.Cause<unknown>) =>
  Effect.sync(() => {
    if (!Cause.hasInterruptsOnly(cause)) console.log(`ERROR [effect] ${label} failed:\n${Cause.pretty(cause)}`);
  });

export const runLogged = <A, E>(eff: Effect.Effect<A, E>, label = "runPromise"): Promise<A> =>
  Effect.runPromise(Effect.tapCause(eff, report(label)));

export const forkLogged = <A, E>(eff: Effect.Effect<A, E>, label = "runFork"): Fiber.Fiber<A, E> =>
  Effect.runFork(Effect.tapCause(eff, report(label)));
