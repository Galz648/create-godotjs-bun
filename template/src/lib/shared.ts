/** Shared helper. Lives under src/lib/ so tools/build.ts does not emit its own bundle. Godot ignores this directory (.gdignore). */
export function sharedTag(script: string): string {
  return `shared:${script}`;
}
