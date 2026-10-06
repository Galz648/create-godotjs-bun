# Day to day with this project

## One-time setup: where is the GodotJS binary?

```sh
bun tools/config.ts set /path/to/godot.macos.editor.universal   # global: every project on this machine uses it
bun tools/config.ts show                                        # what is configured, and where it came from
```

Resolution order: `GODOTJS` in the shell, then `GODOTJS` in this project's `.env` (gitignored, see `.env.example`), then the global config (`~/.config/godotjs/config.json`). A project can override the global binary with its own `.env`. For clickable TypeScript errors and mapped error positions in the editor, point it at the patched editor build (`bin/macos-editor-4.6.1-qjs-ng-clicklink/` in the `godotjs-esm` repo); the stock release works for everything else.

## In Cursor / VS Code

`.vscode/settings.json` points the editor at the project's own TypeScript, and `.vscode/tasks.json` has tasks for the watch build, the Godot editor and the type-check (Terminal > Run Task). For full Godot API autocomplete run `bun run types` once (about 6 MB, regenerate after a Godot upgrade), then **Cmd+Shift+P, "TypeScript: Restart TS Server"** and accept "Use workspace version" if asked.

## The loop

```sh
bun run dev:build      # terminal 1: rebuilds on save (leave it running)
bun run editor         # terminal 2: the Godot editor; press F5 to play
```

Edit in your editor of choice and save. In Godot, press F5 again to run the new code (a running game never hot-swaps; the `hot_reload` addon refreshes the editor's view of scripts without needing window focus). No editor? `bun run dev` rebuilds and relaunches a game window on every save. State you register with `devState("name", { save, load })` (`src/lib/dev-state.ts`) survives that relaunch, so a ticking sim keeps its day and hour; a changed shape is discarded with a `dev-state:` line, and `bun run dev --fresh` starts from scratch every time.

Other scripts: `bun run build` (one build), `bun run start` (run the game), `bun run headless` (run without a window, quits after 300 frames), `bun run headless:mapped` (same, with stack traces mapped to `src/...`), `bun run types` (generate real Godot typings; `bun run types:shim` goes back to the stub), `bun run typecheck`, `bun run export:macos` (release `.app` in `out/`, then a pack check, a headless run of the release app and a debug-build log check; needs the export templates once, see `docs/SHIPPING.md`; `--expect "text"` asserts a log line, `--no-smoke` skips running the app).

## Layout

| Path | What |
|---|---|
| `src/**/*.ts` | every file becomes a Godot script bundle at `.godot/GodotJS/<same path>.js`, except `src/lib/` |
| `src/lib/` | plain shared TypeScript; Bun inlines it into the scripts that import it, Godot never loads it as a script. `gd.ts` is the runtime half of the build plugin |
| `tools/` | build, dev runner, config, launcher, and `tools/plugin` (hidden from Godot with `.gdignore`; so are `typings/`, `src/lib/`, `docs/`) |
| `export_presets.cfg`, `out/` | the macOS export preset (exclude filter hides tooling, never `*.ts`); `out/` is where the exported app lands (gitignored). Shipping, signing and notarizing: `docs/SHIPPING.md` |
| `typings/` | Godot API typings (a small stub until you run `bun run types`) |

Scenes attach the `.ts` path (`res://src/main.ts`), never the bundle.

## Gotchas

- On the stock engine the build plugin (`bun run build`) is what makes these work: `@gd.export()` reads the type and the literal (`100` int, `1.5` / `200.0` float; `@gd.export.int()` / `.float()` when the initializer is not a literal), typed array and Resource exports, `@gd.onready("Label")` after a missing path (later fields still run), and `signal.connect(fn)` with a plain function or arrow (`this` inside a bare function is undefined; use `() => this.method()`). `await signal.as_promise()` also works.
- `set_script` on a JS class still does not run the constructor on the stock engine (`Cannot read from private field`). The plugin warns at build time and does not rewrite the call. Use `ResourceLoader.load(path).call("new")`. A patched engine (dev-only) runs the constructor inside `set_script`.
- Scalar Node export `class_name` stays empty on the stock engine. Clickable TypeScript errors and mapped positions in the editor Output panel need the patched editor. The stock binary prints bundle positions; `bun run headless:mapped` maps them in the terminal.
- Exports and signals use TC39 decorators and `accessor` fields (`@gd.export()` / `@gd.onready()` in `src/lib/gd.ts`). You do not write `@gd.class`: the plugin adds it to a default-exported class that extends a Godot class and has a member `@gd` decorator or a Signal-typed accessor (an explicit `@gd.class` still works). A signal is just `accessor spun!: Signal<(amount: number) => void>` (`@gd.signal()` in front is optional). The same decorators on a class that is not the default export or does not extend a Godot class, and `@gd.export` / `@gd.signal` on a plain field, fail the build with the file and line.
- Build warnings start with `[tooling]` and carry the original `file:line:col`. They never change the output; they flag code that runs but does the wrong thing on the stock engine: `this` in a plain function or method passed to `connect` (use `() => this.method()`), an `@onready` field read in a field initializer or constructor (it is assigned at the start of `_ready`), `node.position.x = 5` (the engine hands back a copy; assign `node.position = ...`), and `await signal` (use `await signal.as_promise()`). Two more look at your scenes: `@gd.onready("Path")` where no scene that attaches the script has that path (the warning names the scene), and where the node is a different class than the field type (`Label` field, `Control` node). They stay silent for scripts no scene attaches, `%Unique` and `..` paths, and paths inside an instanced sub-scene; a node you add in code before `_ready` is not in the scene, so ignore the warning there. A class with `@gd.onready` and no `_ready` of its own still runs its base class's `_ready` (the generated one calls `super._ready?.()`). `connect()` with a class or a non-callable is a build error.
- GDScript globals (`floor`, `clamp`, `print`, `$Node`, `load`/`preload`) have JS forms; see `docs/GDSCRIPT-TO-GODOTJS.md` in `godotjs-esm`.
- `SceneTree.paused` and `Engine.time_scale` do not affect JS timers.
- The editor's Output panel prints ANSI color codes raw; only color output when running in a terminal.
- Opening the project in the editor creates `.uid` files and a `gen/` folder (scene typings, compiled by the build); both are gitignored.

## If something is off

| Symptom | Try |
|---|---|
| `no GodotJS binary configured` | `bun tools/config.ts set <path>` or create `.env` |
| `@gd.export() was not rewritten` at startup | a watch build started BEFORE the plugin or `tools/` changed is still running with the old build code; stop it and run `bun run dev:build` again (or `bun run build` once) |
| Patched engine aborts at exit after `bun run types` (`FATAL ... internal_data_.is_empty()`) | the project's `polyfills/` folder needs its own `package.json` with `{ "type": "commonjs" }` (the starter has it); without it the patched native-ESM loader loads the polyfill as ESM and leaks at shutdown. Only patched builds; typings are written before the abort |
| Editor shows old code | is `bun run dev:build` running? |
| Errors point at `main.js:21746` | you are on the stock binary; use the patched one for mapped positions |
| `javascript file is missing` for a game script | the file must be under `src/` (not `src/lib/`) and built; run `bun run build` |
