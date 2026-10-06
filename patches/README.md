# GodotJS patches

Apply on a pristine checkout of [godotjs/GodotJS](https://github.com/godotjs/GodotJS) at `b1d8b3f` (`fix: enter V8 isolate/context scope before editor codegen compile`), from the module root (`godot-src/modules/GodotJS`). Every hunk applies with `git apply`. `patches/jsb.polyfill.ts` is an early TextEncoder-only sketch and is not applied; the module that ships is created by the first patch and extended by the second.

`scripts/out` is gitignored. The runtime bundle patch adds the three runtime artifacts scons embeds. The editor bundle (`jsb.editor.bundle.js` and its `.d.ts` / `.map`) is not part of these patches; a `skip_js_runtime=yes` build still needs those files from a previous `pnpm build` of the unmodified editor package.

## Order

1. `godotjs-native-esm.patch` — quickjs-ng ESM loader (`bridge/jsb_module_resolver.cpp`), zero-delay timer drain (`bridge/jsb_environment.cpp`, `internal/jsb_timer_manager.h`), and `scripts/jsb.runtime/src/jsb.polyfill.ts` (TextEncoder/TextDecoder, EventTarget, AbortController, fast `setImmediate`, `Error.stack` header). The `main.ts` hunk in this patch requires `jsb.polyfill` before `jsb.inject`; the next patch fixes that order.
2. `godotjs-runtime-require-order.patch` — `require("jsb.inject")` then `require("jsb.polyfill")`. The polyfill's `crypto` helper calls `require("godot")` at load, and that is fatal unless `godot.typeloader` is already cached (inject does that). Also drops the Error wrapper's own frames and adds `crypto.getRandomValues` / `randomUUID`.
3. `godotjs-runtime-bundle.patch` — regenerated `scripts/out/jsb.runtime.bundle.js`, `.js.map`, and `.d.ts` (tsc `outFile` of the runtime, including the require order above). `skip_js_runtime=yes` embeds this file; without it a pristine tree still has the upstream bundle, which does not load the polyfill.
4. `godotjs-source-map-column.patch` — quickjs-ng stack frames are `file.js:LINE:COL` (1-based). The parser takes that form, subtracts 1, and calls `SourceMap::find` (zero-based). The printed mapped frame adds 1 back to line and column, so it matches `tools/unmap.ts`. Classic quickjs (no column) and V8 are unchanged. VLQ source-index and generated-column fields are accumulated as deltas. `sources[i]` is joined to the `.map` directory, passed through `simplify_path`, then `ProjectSettings::localize_path` when the bundle frame used an OS path. `../../../src/main.ts` relative to `res://.godot/GodotJS/src/` prints as `res://src/main.ts`.
5. `godotjs-script-error-link.patch` — `Environment::_call` used to report a caught exception with the C++ error macro, so the editor linked `jsb_environment.cpp`. After the source-map patch, the message already contains `at func (res://….ts:LINE:COL)`. This patch parses the first such `res://` `.ts` frame (native and unmapped bundle frames are skipped) and reports the same full message with `_err_print_error(..., ERR_HANDLER_SCRIPT)` at that file and 1-based line. Godot then prints `SCRIPT ERROR:` with `at: (res://file:line)`, and Output / Debugger > Errors store that path as the script-source link. The click goes through `ScriptEditor::edit`, which honors Editor Settings > Text Editor > External (`{project}`, `{file}`, `{line}`, `{col}`). Godot's error record has no column, so the click passes column 0 (`{col}` becomes 1). If no `res://` `.ts` frame parses, the call site still uses `JSB_LOG` (C++ file and line).

```sh
cd GodotJS
git apply /path/to/patches/godotjs-native-esm.patch
git apply /path/to/patches/godotjs-runtime-require-order.patch
git apply /path/to/patches/godotjs-runtime-bundle.patch
git apply /path/to/patches/godotjs-source-map-column.patch
git apply /path/to/patches/godotjs-script-error-link.patch
cd ../godot-src
scons platform=macos arch=arm64 target=editor use_quickjs_ng=yes skip_js_runtime=yes vulkan=no dev_build=no
```

Copy `bin/godot.macos.editor.arm64` aside (for example `bin/macos-editor-4.6.1-qjs-ng-srcmap/`, or `bin/macos-editor-4.6.1-qjs-ng-clicklink/` once the script-error link patch is included). Do not replace the stock universal binary. Do not overwrite a binary the editor is already running.
