// LOGIC test: pure TypeScript, no Godot. Run with `bun test` (or `bun run test`). See docs/DAILY.md, "Testing your game".
import { describe, expect, it } from "bun:test";
import { MAX_STAMINA, recoverStamina } from "../../src/lib/rest";

describe("recoverStamina", () => {
  it("adds 5 per hour", () => {
    expect(recoverStamina(50, 2)).toBe(60);
  });
  it("never goes above the maximum", () => {
    expect(recoverStamina(98, 3)).toBe(MAX_STAMINA);
  });
  it("never goes below zero", () => {
    expect(recoverStamina(3, -10)).toBe(0);
  });
});
