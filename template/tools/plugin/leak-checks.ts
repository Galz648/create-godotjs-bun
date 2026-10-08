// Build-time WARNINGS (never errors, never edits) for code that runs but leaks or bloats (ticket 441), one switch each, all on:
//   effectBarrel   `import ... from "effect"` (the barrel): every script bundle carries the whole library (2.4x to 3.9x bigger).
//                  Safe form: one namespace per subpath, `import * as Effect from "effect/Effect"`. Type-only imports are fine.
//   leakCalls      `create_timer(...)`, `create_tween(...)`, `get_slide_collision(i)`, `get_last_slide_collision()`: the engine
//                  keeps every object it hands back to JS while it also holds it (the leak family, docs/DAILY.md leak table).
//                  Safe forms: setTimeout / Effect.sleep / a Timer node; tweenProperty() and slideCollisions() from src/lib/leak-free.ts.
//   inputVirtuals  an `_input` / `_unhandled_input` method on a class that extends a Godot class: one leaked InputEvent per event.
//                  Safe form: `onInputEvent(this, (ev) => ...)` from src/lib/leak-free.ts in _ready, or poll Input in _process.
// A method the project declares itself under one of those names (a user class with its own `create_tween`) is not judged.
// Opt out for one file (a test that leaks on purpose): a comment `// godotjs-plugin-allow: leakCalls inputVirtuals` (switch names).
import ts from "typescript";
import { extendsGodotClass } from "./diagnostics.ts";

export type LeakSwitch = "effectBarrel" | "leakCalls" | "inputVirtuals";
export interface LeakProblem {
  node: ts.Node;
  switch: LeakSwitch;
  message: string;
}

const LEAK_CALLS: Record<string, string> = {
  create_timer:
    "`create_timer()` leaks one engine object per call on GodotJS (the leak family, docs/DAILY.md). Use `setTimeout`, `Effect.sleep`, `FrameClock.sleepCounting` or a one-shot Timer node.",
  create_tween:
    "`create_tween()` leaks two engine objects per call on GodotJS (the tween and each tweener; docs/DAILY.md). Use `tweenProperty(node, path, to, seconds, done?)` from src/lib/leak-free.ts, an AnimationPlayer, or animate in `_process`.",
  get_slide_collision:
    "`get_slide_collision()` leaks one KinematicCollision per call on GodotJS (docs/DAILY.md). Use `slideCollisions(body)` from src/lib/leak-free.ts.",
  get_last_slide_collision:
    "`get_last_slide_collision()` leaks one KinematicCollision per call on GodotJS (docs/DAILY.md). Use `slideCollisions(body)` from src/lib/leak-free.ts.",
};
const INPUT_VIRTUALS = new Set(["_input", "_unhandled_input"]);

/** Switches a file turns off for itself with `godotjs-plugin-allow: <names>`. */
export function allowedIn(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const m of sf.text.matchAll(/godotjs-plugin-allow:\s*([A-Za-z, \t]+)/g)) for (const name of m[1].split(/[\s,]+/)) if (name) out.add(name);
  return out;
}

function userDeclared(symbol: ts.Symbol | undefined): boolean {
  return (symbol?.declarations ?? []).some((d) => !d.getSourceFile().isDeclarationFile);
}

/** The barrel `"effect"` as a value import or re-export (`import type`, all-type specifiers and `export type` are erased: fine). */
function barrelImport(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node)) {
    if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== "effect") return false;
    const clause = node.importClause;
    if (!clause) return true; // import "effect"
    if (clause.isTypeOnly) return false;
    if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return true;
    const els = clause.namedBindings.elements;
    return els.length === 0 || els.some((e) => !e.isTypeOnly);
  }
  if (ts.isExportDeclaration(node)) {
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== "effect") return false;
    if (node.isTypeOnly) return false;
    return !(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every((e) => e.isTypeOnly));
  }
  return false;
}

export function leakProblems(node: ts.Node, checker: ts.TypeChecker, on: Readonly<Record<LeakSwitch, boolean>>): LeakProblem[] {
  const out: LeakProblem[] = [];
  if (on.effectBarrel && barrelImport(node)) {
    out.push({
      node,
      switch: "effectBarrel",
      message: 'imports the Effect barrel `"effect"`: Bun keeps its unused modules, so this script bundle carries the whole library (2.4x to 3.9x bigger). Import one namespace per subpath: `import * as Effect from "effect/Effect"` (same for Layer, Stream, Schema, ...).',
    });
  }
  if (on.leakCalls && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const name = node.expression.name.text;
    if (Object.hasOwn(LEAK_CALLS, name) && !userDeclared(checker.getSymbolAtLocation(node.expression.name))) {
      out.push({ node, switch: "leakCalls", message: LEAK_CALLS[name] });
    }
  }
  if (on.inputVirtuals && ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && INPUT_VIRTUALS.has(node.name.text)) {
    const cls = node.parent;
    const isStatic = (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
    if (ts.isClassLike(cls) && !isStatic && extendsGodotClass(cls, checker)) {
      out.push({
        node,
        switch: "inputVirtuals",
        message: `\`${node.name.text}\` on a class that extends a Godot class leaks one engine object per input event (every key, mouse move, joypad axis; docs/DAILY.md). Drop the method and call \`onInputEvent(this, (ev) => ...${node.name.text === "_unhandled_input" ? ", { unhandled: true }" : ""})\` from src/lib/leak-free.ts in _ready, or poll Input in _process.`,
      });
    }
  }
  return out;
}
