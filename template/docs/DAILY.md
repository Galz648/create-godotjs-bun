# Day to day with this project

## One-time setup: where is the GodotJS binary?

```sh
bun tools/config.ts set /path/to/godot.macos.editor.universal   # global: every project on this machine uses it
bun tools/config.ts show                                        # what is configured, and where it came from
```

Resolution order: `GODOTJS` in the shell, then `GODOTJS` in this project's `.env` (gitignored, see `.env.example`), then the global config (`~/.config/godotjs/config.json`). A project can override the global binary with its own `.env`. For clickable TypeScript errors and mapped error positions in the editor, point it at the patched editor build (`bin/macos-editor-4.6.1-qjs-ng-clicklink/` in the `godotjs-esm` repo); the stock release works for everything else.

## The loop

```sh
bun run dev:build      # terminal 1: rebuilds on save (leave it running)
bun run editor         # terminal 2: the Godot editor; press F5 to play
```

Edit in your editor of choice and save. In Godot, press F5 again to run the new code (a running game never hot-swaps; the `hot_reload` addon refreshes the editor's view of scripts without needing window focus). No editor? `bun run dev` rebuilds and relaunches a game window on every save.

Other scripts: `bun run build` (one build), `bun run start` (run the game), `bun run headless` (run without a window, quits after 300 frames), `bun run headless:mapped` (same, with stack traces mapped to `src/...`), `bun run types` (generate real Godot typings; `bun run types:shim` goes back to the stub), `bun run typecheck`.

## Layout

| Path | What |
|---|---|
| `src/**/*.ts` | every file becomes a Godot script bundle at `.godot/GodotJS/<same path>.js`, except `src/lib/` |
| `src/lib/` | plain shared TypeScript; Bun inlines it into the scripts that import it, Godot never loads it as a script. `gd.ts` is the runtime half of the build plugin |
| `tools/` | build, dev runner, config, launcher, and `tools/plugin` (hidden from Godot with `.gdignore`; so are `typings/`, `src/lib/`, `docs/`) |
| `typings/` | Godot API typings (a small stub until you run `bun run types`) |

Scenes attach the `.ts` path (`res://src/main.ts`), never the bundle.

## Gotchas

- On the stock engine the build plugin (`bun run build`) is what makes these work: `@gd.export()` reads the type and the literal (`100` int, `1.5` / `200.0` float; `@gd.export.int()` / `.float()` when the initializer is not a literal), typed array and Resource exports, `@gd.onready("Label")` after a missing path (later fields still run), and `signal.connect(fn)` with a plain function or arrow (`this` inside a bare function is undefined; use `() => this.method()`). `await signal.as_promise()` also works.
- `set_script` on a JS class still does not run the constructor on the stock engine (`Cannot read from private field`). The plugin warns at build time and does not rewrite the call. Use `ResourceLoader.load(path).call("new")`. A patched engine (dev-only) runs the constructor inside `set_script`.
- Scalar Node export `class_name` stays empty on the stock engine. Clickable TypeScript errors and mapped positions in the editor Output panel need the patched editor. The stock binary prints bundle positions; `bun run headless:mapped` maps them in the terminal.
- Exports and signals use TC39 decorators and `accessor` fields (`@gd.class` / `@gd.export()` / `@gd.signal()` in `src/lib/gd.ts`).
- GDScript globals (`floor`, `clamp`, `print`, `$Node`, `load`/`preload`) have JS forms; see `docs/GDSCRIPT-TO-GODOTJS.md` in `godotjs-esm`.
- `SceneTree.paused` and `Engine.time_scale` do not affect JS timers.
- The editor's Output panel prints ANSI color codes raw; only color output when running in a terminal.
- Opening the project in the editor creates `.uid` files and a `gen/` folder (scene typings, compiled by the build); both are gitignored.

## If something is off

| Symptom | Try |
|---|---|
| `no GodotJS binary configured` | `bun tools/config.ts set <path>` or create `.env` |
| Editor shows old code | is `bun run dev:build` running? |
| Errors point at `main.js:21746` | you are on the stock binary; use the patched one for mapped positions |
| `javascript file is missing` for a game script | the file must be under `src/` (not `src/lib/`) and built; run `bun run build` |
