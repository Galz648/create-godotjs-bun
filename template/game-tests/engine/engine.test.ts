// ENGINE test: runs inside a headless Godot (`bun run test:engine`), because it touches nodes, signals and frames.
// Logic that needs none of that belongs in tests/logic (`bun test`). See docs/DAILY.md, "Testing your game".
import { is_instance_valid, Node, ResourceLoader, type Script, type Signal } from "godot";
import { describe, expect, it } from "../../tools/test-kit";
import { devState } from "../../src/lib/dev-state";
import { hot } from "../../src/lib/hot";
import { hotReload } from "../../src/lib/hot-reload";

// A script class (src/scripts/Spinner.ts) is made through its script: `call("new")`, the way src/main.ts does it.
type Spinner = Node & { speed: number; spun: Signal<(amount: number) => void> };
const makeSpinner = (): Spinner => (ResourceLoader.load("res://src/scripts/Spinner.ts") as Script).call("new") as Spinner;

describe("Spinner", () => {
  it("is a Node with its exported default, and joins the tree", ({ add }) => {
    const spinner = add(makeSpinner());
    expect(spinner.speed).toBeCloseTo(1.5);
    expect(spinner.has_signal("spun")).toBe(true);
  });

  it("delivers a signal to a connected function, and a frame later is still connected", async ({ add, nextFrame }) => {
    const spinner = add(makeSpinner());
    const seen: number[] = [];
    spinner.spun.connect((amount) => seen.push(amount)); // added after _ready's own emit
    spinner.spun.emit(7);
    expect(seen).toEqual([7]);
    await nextFrame();
    spinner.spun.emit(8);
    expect(seen).toEqual([7, 8]);
  });

  it("is freed after queue_free, one frame later", async ({ root, nextFrame }) => {
    const spinner = makeSpinner();
    root.add_child(spinner);
    spinner.queue_free();
    expect(is_instance_valid(spinner)).toBe(true); // queued, not freed yet
    await nextFrame();
    await nextFrame();
    expect(is_instance_valid(spinner)).toBe(false);
  });
});

// "Hot-reload safe" means the dev-only helpers are harmless in a game that is not under `bun run dev`: they do nothing.
describe("dev helpers outside bun run dev", () => {
  it("hotReload() and devState() are no-ops", ({ root }) => {
    let loaded = false;
    hotReload(); // must not throw or start timers
    const restored = devState("engine-test", { save: () => ({ n: 1 }), load: () => { loaded = true; } });
    expect(restored).toBe(false);
    expect(loaded).toBe(false);
    expect(root.get_tree()).toBeTruthy();
  });

  it("hot() re-points an old instance at a redefined class", () => {
    const First = hot("EngineTestCounter", class { n = 1; label() { return "old"; } });
    const first = new First();
    const Second = hot("EngineTestCounter", class { n = 1; label() { return "new"; } });
    expect(first.label()).toBe("new"); // the old instance runs the new method body
    expect(first instanceof Second).toBe(true);
  });
});

describe("the kit itself", () => {
  it("awaits promises", async () => {
    expect(await Promise.resolve(41) + 1).toBe(42);
  });
  it("rejects with rejects.toThrow", async () => {
    // Reject LATER (a timer): the engine logs "unhandled promise rejection" for a promise that is already rejected when made, even if a handler follows at once.
    const later = new Promise<void>((_, reject) => setTimeout(() => reject(new Error("boom")), 1));
    await expect(later).rejects.toThrow("boom");
  });
  it("toThrow on a function", () => {
    expect(() => { throw new Error("nope"); }).toThrow("nope");
  });
  it.skip("a test that is parked", () => { throw new Error("never runs"); });
});
