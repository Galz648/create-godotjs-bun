# Changelog

Format: [Keep a Changelog](https://keepachangelog.com). Versions follow [Semantic Versioning](https://semver.org); before 1.0 a minor bump (0.x.0) adds features or may change behaviour, a patch bump (0.x.y) is fixes only.

## 0.5.1

### Fixed
- **Windows**: the build plugin's source filter now accepts backslash paths (on Windows `@gd.export()` was never rewritten and the game failed to load), and `bun run test:engine` writes forward slashes into the generated test entry. The CI workflow runs scaffold, type-check, build, headless run, logic tests and engine tests on macOS, Linux and Windows, all green on this release (the first Windows evidence; exporting and running an exported Windows build is still unverified).

## 0.5.0

### Added
- **Effect game kit** (Effect flavour; none of it ships with `--no-effect`): `src/lib/services/` (Settings, Input, Assets, Audio, Random with a seeded generator, GodotConfig), `godot-effect.ts` (signals and node-bound fibers as Effects and Streams), `game-clock.ts` (follows pause and `time_scale`), `frame-clock.ts` (driven by the frame `delta`, deterministic under `--fixed-fps`, with a drift-free Godot-Timer schedule), and a 25-section cookbook (`docs/EFFECT.md`) whose snippets are type-checked and whose claims name the test that pins them.
- **Testing kit**: `bun run test` (logic tests) and `bun run test:engine` (tests inside the engine, TAP, plan check, log lint).
- **Hot reload for plain modules** (`hot("Name", cls)`), a shared `devState` registry, and an honest runner (it never prints "swapped" unless the code is running).
- **Build-time ENGINE ABORT guards**: `new Vector2(<Vector2i>)` and its family, `new Basis(<Quaternion>)`, `new GArray(<Packed array>)`, `.unreference()`, a negative `input_count` and others now fail the build with the engine ticket and the safe form, instead of killing the process at run time. Switch: `abortGuards`.
- **Value-type diagnostics**: warnings for writes that are silently lost (`node.rotation.y = x`, `velocity.y -= g`), for value types in template literals and `JSON.stringify`, and for iterating Packed arrays; errors for conversion constructors that return garbage. Switches: `lostWrites`, `valueStrings`, `packedIteration`, `badConversions`.
- **Any engine class can be a script base** (`Area2D`, `CanvasLayer`, `RigidBody2D`, ...) with `@gd.export()`, `@gd.onready()` and Signal accessors; exported Resource and Node types the stand-in typings lack (`PackedScene`, `Texture2D`) are classified from the generated typings.
- **Polyfills**: `global` (core), and opt-in `url.js`, `structured-clone.js`, `timer-accuracy.js` (timers never early, interval drift under 15 ms) and `intl.js` (NumberFormat, DateTimeFormat in UTC and fixed offsets, Collator, PluralRules, ListFormat, RelativeTimeFormat for six locales; no named time zones).
- **Opt-in libraries**: `soak-probe.ts` (assert memory slopes in your own tests), `input-replay.ts` (record and replay real input under `--fixed-fps`), `leak-free.ts` (workarounds for the engine's object leaks).
- **Release crash logs**: the starter turns on `debug/file_logging`, so an exported game writes `user://logs/godot.log` (see `docs/SHIPPING.md`).
- **CI workflow** (`.github/workflows/ci.yml` in the public repo): scaffold, type-check, build, headless run and tests on macOS, Linux and Windows. Windows is allowed to fail until it has passed once.
- **Toolchain update path**: new projects get `tools/toolchain.json` (version, a revision hash and a sha256 per toolchain file) and `tools/update.ts`. An update now lists the template's `package.json` scripts the project lacks (it never edits `package.json`) and prints the toolchain revision change. `bun tools/update.ts <template> --adopt` takes the current files as the baseline.
- Hidden `--template <dir>` flag: scaffold from the `starter/` of a source checkout.

### Changed
- **The Godot binary is picked by `GODOTJS` in the shell or the global config only**; a project `.env` (and `.env.example`) is no longer part of it.
- The build warns when a helper module outside `src/lib/` is imported by a script (it is bundled as its own entry, ahead of the polyfill) and fails with one clear line when `typescript` is not installed.
- `TextDecoder` is a WHATWG state machine (streaming); `Symbol.dispose` and `Symbol.asyncDispose` are in the core polyfill.
- Dev builds minify identifiers (Bun otherwise gives every decorated class the same hidden helper).

### Fixed
- Timers armed in the first frame no longer fire early; `console.error` no longer prints a garbage `at:` line through the kit; a missing export fails the build instead of producing `undefined(...)`.

### Notes (engine behaviour, all pinned by tests and documented in `docs/DAILY.md`)
- `create_timer()`, `create_tween()`, every `_input` event, `get_slide_collision()` and `move_and_collide()` leak engine objects until the process exits (one binding defect; the kit's `leak-free.ts` avoids it).
- `clearTimeout`/`clearInterval` with a number `setTimeout` did not return can corrupt the timer table and abort the process; about 16,000 timers due in one tick overflow a handle stack.
- Hot reload keeps about 0.5 MB per swap of a script that imports Effect: restart `bun run dev` after a few hundred swaps.
- Stock QuickJS-ng has no `Intl`, a few date and BigInt differences from Bun, and runs `require`d files in strict mode (`docs/DAILY.md`, "JavaScript differences").
- Verified on macOS arm64 only (headless; rendering, audio and real input are unverified). Windows and Linux are covered by the CI workflow, not yet by a run.

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
