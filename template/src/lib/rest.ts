// Pure game logic (ADR 0006): no Godot, no Effect, so `bun test` runs it in milliseconds. Sample for the testing kit
// (tests/logic/rest.test.ts); replace it with your own rules.
export const MAX_STAMINA = 100;
export const STAMINA_PER_HOUR = 5;

/** Stamina after resting `hours` hours: 5 per hour, never above 100 and never below 0. */
export function recoverStamina(stamina: number, hours: number): number {
  return Math.min(MAX_STAMINA, Math.max(0, stamina + hours * STAMINA_PER_HOUR));
}
