# Changelog

Format: [Keep a Changelog](https://keepachangelog.com). Versions follow [Semantic Versioning](https://semver.org); before 1.0 a minor bump (0.x.0) adds features or may change behaviour, a patch bump (0.x.y) is fixes only.

## 0.4.0

### Added
- **Build plugin, less boilerplate** (stock engine): a script class with `@gd.export()`, `@gd.onready()` or a `Signal`-typed `accessor` is registered automatically (an explicit `@gd.class` still works); `accessor spun!: Signal<(amount: number) => void>` declares a signal with no decorator; the generated `_ready` calls `super._ready?.()` so it never shadows a base class's `_ready`.
- **Build-time diagnostics** (errors and warnings with the original file:line:col, never on correct code): member decorators on a class that is not a default-exported Godot class, `@gd.export`/`@gd.signal` on a plain field, `connect()` given a class or non-callable, `this` inside a plain function passed to `connect`, writes into value types returned by the engine (`node.position.x = 5`), `await signal`, an `@onready` field read in a field initializer, and `@gd.onready("Path")` checked against the scenes that attach the script (missing path, wrong node type).
- **Restart with state preserved for `bun run dev`**: opt in with `devState(name, { save, load })` (`src/lib/dev-state.ts`); the dev runner asks the game to save before relaunching, the new process restores it. Dev-only, discards stale or incompatible state with one log line. `--fresh` skips it.
- **`bun run export:macos`**: builds, exports a release `.app` into `out/`, and checks it (pack contents, a headless run of the release app with an external probe, a debug-build log check with `--expect "text"`). Prints `EXPORT PASS` or `EXPORT FAIL`. New projects get a `macOS` export preset, the ETC2/ASTC project setting and a placeholder bundle id (`com.example.<name>`: change it before you ship).
- `docs/SHIPPING.md`: installing the export templates, what the export check does and does not prove, macOS signing and notarization (an unverified procedure), Windows and Linux findings.
- Cursor / VS Code workspace settings (`.vscode/settings.json` pointing at the project's TypeScript, `tasks.json`) and a type-check pre-commit hook.

### Changed
- `bun run types` no longer fails when a patched engine aborts at exit after `Type generation complete`; it warns and carries on.
- `0x1E` and `1_000` literals are ints; `obj.connect(nameVar, fn)` now wraps `fn`; `fn.bind(this)` no longer triggers a false build error.
- `polyfills/package.json` (`{ "type": "commonjs" }`) avoids a shutdown leak in patched engine builds that load the polyfill as ESM.

### Notes
- `set_script()` on a JS script class still skips the constructor on the stock engine (the plugin warns). Exported fields can still throw after an EDITOR reload (design and spike in the source repo, not shipped yet).
- Windows and Linux exports were assessed but not run; only the macOS release export is verified.

## 0.3.0

### Added
- Build-time plugin in every new project (`tools/plugin/`): typed exports (`@gd.export() accessor speed: number = 200.0`, int vs float read from the literal), `@onready` that keeps going after a missing path, and `signal.connect(fn)` with a plain function. All of it works on the STOCK GodotJS engine and its stock export templates.
- The Godot binary is configuration (`bun tools/config.ts set|show|unset`, or a project `.env`), not a shell export.

### Notes
- `set_script()` on a JS script class still skips the class constructor on the stock engine; the plugin warns at build time and points to `ResourceLoader.load(path).call("new")`.
- Clickable TypeScript errors and mapped error positions in the editor need the optional patched engine (`patches/`).

## 0.2.0
- `--no-effect`: a plain TypeScript demo and no `effect` dependency.

## 0.1.0
- First release: scaffold a GodotJS + Bun project from the starter.
