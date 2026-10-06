# create-godotjs-bun

Start a [GodotJS](https://github.com/godotjs/GodotJS) game project where **Bun** bundles your TypeScript and the stock GodotJS release runs it inside Godot. No engine fork needed.

```sh
bunx github:Galz648/create-godotjs-bun#v0.3.0 my-game --name "My Game"
cd my-game
bun run dev:build   # terminal 1: rebuild on save
bun run editor      # terminal 2: the Godot editor, press F5 to play
```

`#v0.3.0` pins a release (see the tags). `bunx github:Galz648/create-godotjs-bun my-game` takes the latest default branch.

## What you need

- [Bun](https://bun.sh) 1.1 or newer.
- A GodotJS **editor** binary. The stock release for Godot 4.6.1 (quickjs-ng) works for everything: <https://github.com/godotjs/GodotJS/releases> (for example `macos-editor-4.6.1-qjs-ng.zip`). Tell the project where it is once, for every project on your machine:

  ```sh
  cd my-game
  bun tools/config.ts set /path/to/godot.macos.editor.universal   # saved in ~/.config/godotjs/config.json
  bun tools/config.ts show
  ```

  Or pass it when you scaffold: `--godot /path/to/binary` (written to the project's `.env`), or export `GODOTJS`. Resolution order: `GODOTJS` in the shell or the project's `.env`, then the global config.

## Options

```
bunx create-godotjs-bun <target-dir> [--name "Project Name"] [--godot /path/to/binary] [--no-effect] [--no-install] [--no-git]
```

`--no-effect` starts without [Effect](https://effect.website): a plain demo script and no `effect` dependency (a much smaller bundle).

It copies the template, names the project, runs `bun install` and the first build, and starts a git repo with a type-check pre-commit hook (`--no-git` to skip).

## What you get

A build-time plugin (stock engine, no patches needed) gives you typed exports (`@gd.export() accessor speed: number = 200.0`: int vs float read from the literal), `@onready` that survives a missing path, and `signal.connect(fn)` with a plain function.


TypeScript sources in `src/`, each file bundled by Bun to `.godot/GodotJS/<same path>.js` and attached in scenes by its `.ts` path; shared code in `src/lib/`; a hot-reload editor addon; typings; a dev runner that rebuilds and relaunches the game on save (`bun run dev`); source-mapped stack traces; and `docs/DAILY.md` with the loop, layout and gotchas. The default demo script uses [Effect](https://effect.website); pass `--no-effect` for a plain TypeScript demo instead.

## Optional: a patched editor build

`patches/` holds small patches for the GodotJS engine module (see `patches/README.md`): they map error positions through source maps and make TypeScript frames in the editor's Output panel clickable (they can open your external editor at the line). Building the engine is optional; the stock release is enough to develop.

## License

MIT
