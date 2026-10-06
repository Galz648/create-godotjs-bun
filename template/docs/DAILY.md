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
| `src/lib/` | plain shared TypeScript; Bun inlines it into the scripts that import it, Godot never loads it as a script |
| `tools/` | build, dev runner, config, launcher (hidden from Godot with `.gdignore`; so are `typings/`, `src/lib/`, `docs/`) |
| `typings/` | Godot API typings (a small stub until you run `bun run types`) |

Scenes attach the `.ts` path (`res://src/main.ts`), never the bundle.

## Gotchas

- Create script instances from code with `load(path).call("new")`; `new Node()` plus `set_script()` leaves `accessor` fields broken.
- `@export` and signals use TC39 decorators and `accessor` fields (`createClassBinder()` from `godot.annotations`).
- `signal.connect(fn)` needs a `Callable`; use `await signal.as_promise()` with plain JS.
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
