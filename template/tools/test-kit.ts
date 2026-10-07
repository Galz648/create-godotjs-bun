// The in-engine test kit: describe / it / expect, async tests, TAP output. It runs INSIDE Godot (tools/test.ts builds the
// test files into one scene bundle and launches it headless), so it must not touch Bun or Node APIs (ADR 0012).
// It is test-only: nothing under src/ imports it, so it never reaches a release bundle.
//
//   import { describe, it, expect } from "../../tools/test-kit";
//   describe("spinner", () => {
//     it("emits", async ({ add, nextFrame }) => { ... });          // ctx: root node, add() (freed after the test), nextFrame()
//     it.effect("an Effect program", () => program);                // after `import "../effect-support"`
//   });
import type { Node } from "godot";

export interface TestContext {
  /** The node the test run lives under (it is in the scene tree). */
  root: Node;
  /** Add a node under root; it is queue_free()d after the test, pass or fail. Returns the node. */
  add<T extends Node>(node: T): T;
  /** Resolves on the next process frame. */
  nextFrame(): Promise<void>;
}
type Body = (ctx: TestContext) => unknown;
type Case = { name: string; fn?: Body; timeout: number };
const cases: Case[] = [];
const prefix: string[] = [];
const DEFAULT_TIMEOUT_MS = 5000;

export function describe(name: string, body: () => void): void {
  prefix.push(name);
  try { body(); } finally { prefix.pop(); }
}
function register(name: string, fn: Body | undefined, timeout = DEFAULT_TIMEOUT_MS): void {
  cases.push({ name: [...prefix, name].join(" > "), fn, timeout });
}
type EffectRunner = (effect: any) => Promise<unknown>;
let runEffect: EffectRunner | undefined;
/** Tell `it.effect` how to run an Effect (tests/effect-support.ts does it with Effect.runPromise). Kept out of this file so a project without Effect compiles. */
export function useEffectRunner(run: EffectRunner): void { runEffect = run; }

export const it = Object.assign((name: string, fn: Body, timeoutMs?: number) => register(name, fn, timeoutMs), {
  /** A test whose body returns an Effect; it runs with the runner from useEffectRunner and fails with the Effect's error. */
  effect: (name: string, fn: (ctx: TestContext) => unknown, timeoutMs?: number) =>
    register(name, (ctx) => {
      if (!runEffect) throw new Error('it.effect needs a runner: add `import "../effect-support";` to the test file');
      return runEffect(fn(ctx));
    }, timeoutMs),
  /** Reported as `ok ... # SKIP`, never run. */
  skip: (name: string, _fn?: Body) => register(name, undefined),
});
export const test = it;

// --- expect ---
const show = (v: unknown): string => {
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "function") return "[function]";
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
};
const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && same((a as any)[k], (b as any)[k]));
};
function matchers(actual: any, negate: boolean) {
  const check = (ok: boolean, msg: string): void => { if (ok === negate) throw new Error(`${negate ? "not " : ""}${msg}`); };
  const thrown = (): { e: unknown } | undefined => { try { actual(); } catch (e) { return { e }; } return undefined; };
  return {
    toBe: (e: unknown) => check(Object.is(actual, e), `expected ${show(actual)} toBe ${show(e)}`),
    toEqual: (e: unknown) => check(same(actual, e), `expected ${show(actual)} toEqual ${show(e)}`),
    toBeCloseTo: (e: number, digits = 5) => check(Math.abs(actual - e) < 10 ** -digits / 2, `expected ${actual} toBeCloseTo ${e} (${digits} digits)`),
    toBeGreaterThan: (e: number) => check(actual > e, `expected ${actual} toBeGreaterThan ${e}`),
    toBeGreaterThanOrEqual: (e: number) => check(actual >= e, `expected ${actual} toBeGreaterThanOrEqual ${e}`),
    toBeLessThan: (e: number) => check(actual < e, `expected ${actual} toBeLessThan ${e}`),
    toBeLessThanOrEqual: (e: number) => check(actual <= e, `expected ${actual} toBeLessThanOrEqual ${e}`),
    toBeTruthy: () => check(!!actual, `expected ${show(actual)} truthy`),
    toBeFalsy: () => check(!actual, `expected ${show(actual)} falsy`),
    toBeNull: () => check(actual === null, `expected ${show(actual)} null`),
    toBeUndefined: () => check(actual === undefined, `expected ${show(actual)} undefined`),
    toContain: (e: unknown) => check(actual.includes(e), `expected ${show(actual)} toContain ${show(e)}`),
    toHaveLength: (n: number) => check(actual.length === n, `expected length ${actual.length} toHaveLength ${n}`),
    /** `expect(() => f()).toThrow()`; with text, the message must contain it. */
    toThrow: (text?: string) => {
      const t = thrown();
      const msg = t ? String((t.e as Error)?.message ?? t.e) : "";
      check(!!t && (text === undefined || msg.includes(text)), t ? `expected error "${msg}" toThrow "${text}"` : "expected function toThrow");
    },
  };
}
export function expect(actual: unknown) {
  return Object.assign(matchers(actual, false), {
    not: matchers(actual, true),
    /** `await expect(promise).rejects.toThrow("text")` */
    rejects: {
      toThrow: async (text?: string) => {
        let err: unknown, did = false;
        try { await actual; } catch (e) { err = e; did = true; }
        const msg = String((err as Error)?.message ?? err);
        if (!did) throw new Error("expected promise to reject, it resolved");
        if (text !== undefined && !msg.includes(text)) throw new Error(`expected rejection "${msg}" toThrow "${text}"`);
      },
    },
  });
}

// --- the runner ---
const withTimeout = <T>(p: Promise<T>, ms: number, name: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${name}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

/** Run every registered test under `root` and print TAP through `log`. Resolves to the exit code: 0 when all passed, else 1. */
export async function runAll(log: (line: string) => void, root: Node): Promise<number> {
  const tree = root.get_tree() as unknown as { process_frame: { as_promise(): Promise<unknown> } };
  const nextFrame = async (): Promise<void> => { await tree.process_frame.as_promise(); };
  log(`TAP version 13\n1..${cases.length}`);
  let failed = 0;
  for (const [i, c] of cases.entries()) {
    const added: Node[] = [];
    const ctx: TestContext = { root, nextFrame, add: (n) => { root.add_child(n); added.push(n); return n; } };
    try {
      if (!c.fn) {
        log(`ok ${i + 1} - ${c.name} # SKIP`);
      } else {
        await withTimeout(Promise.resolve().then(() => c.fn!(ctx)), c.timeout, c.name);
        log(`ok ${i + 1} - ${c.name}`);
      }
    } catch (e) {
      failed++;
      log(`not ok ${i + 1} - ${c.name}\n  # ${String((e as Error)?.message ?? e).split("\n")[0]}`);
    } finally {
      for (const n of added) n.queue_free();
    }
  }
  log(`# ${cases.length - failed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}
