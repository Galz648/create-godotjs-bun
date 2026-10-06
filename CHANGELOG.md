# Changelog

Format: [Keep a Changelog](https://keepachangelog.com). Versions follow [Semantic Versioning](https://semver.org); before 1.0 a minor bump (0.x.0) adds features or may change behaviour, a patch bump (0.x.y) is fixes only.

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
