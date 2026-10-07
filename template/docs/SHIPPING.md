# Shipping a game

`bun run export:macos` makes a macOS `.app` and checks it. This page says what that command proves, how to
sign and notarize the result, and what is known about Windows and Linux. Everything that could not be tested
on the machine that wrote this page is marked **UNVERIFIED**. No Apple Developer certificate was available, so
all of section 3 is UNVERIFIED as a procedure (the commands are Apple's and Godot's documented ones; the
GodotJS-specific entitlement reasoning is inference and is labelled).

## 0. Game jam checklist (no Apple Developer account; design notes: `docs/design/jam-shipping.md` in the repo)

`bun run export:macos` ends with `dist/<Name>-macos.zip`: the app ad-hoc signed (`codesign --force --deep -s -`) plus `README-macos.txt` for players,
then re-checks everything FROM the zip (`ditto -x -k` in a fresh directory, `codesign --verify --deep --strict`, the release app headless with the probe,
and a control: a one-byte-tampered copy must fail verification). `--no-zip` skips it.

- [ ] **Freeze the toolchain** at the start: no engine, template, Effect or `bun.lock` changes during the jam (`bun install --frozen-lockfile`); note the engine version and template tag you exported with.
- [ ] **Export early and on every platform you promise**, on day one with the empty game, then again after each big change. Do not find out on the last evening that the build does not start on a clean machine.
- [ ] Set `application/bundle_identifier` (macOS) and a game name (`config/name` in `project.godot`; it names the app and the zip).
- [ ] macOS: `bun run export:macos` prints `EXPORT PASS`; open the `.app` from the unzipped archive by hand (window, input, audio, save/load).
- [ ] Windows (second): section 5; test on a real Windows machine (checklist there) before you upload.
- [ ] **itch.io upload** (5 lines): create a project, kind of project "Downloadable"; upload `dist/<Name>-macos.zip` (and the Windows zip) with the platform tags set (macOS / Windows);
  paste the Gatekeeper note below into the page description; set the version in `application/version`; test by downloading the file from itch with a browser on a second Mac (the browser adds the quarantine flag);
  optional: `butler push dist/<Name>-macos.zip you/game:macos` does the same from the command line.
- [ ] **Gatekeeper note for the page** (players of an ad-hoc signed app need it): "macOS: unzip, double-click the app, click Done on the warning, then System Settings > Privacy & Security > Open Anyway (macOS 15 and later; before that: right-click > Open). Or in Terminal: `xattr -dr com.apple.quarantine <path to the .app>`."
- [ ] **Player crash logs:** the starter turns on `debug/file_logging/enable_file_logging`, so a release build writes `user://logs/godot.log` (macOS: `~/Library/Application Support/Godot/app_userdata/<Name>/logs/`; Windows: `%APPDATA%\\Godot\\app_userdata\\<Name>\\logs\\`). Ask players who report a grey screen or a crash for that file; script errors and stack positions are in it. Keep it on for the jam.
- [ ] The pack contains source maps (`.godot/GodotJS/**/*.js.map`, about 10x the size of the bundle); that is fine for a jam, and they make crash stacks readable.

## 1. Export for macOS

```sh
bun run export:macos                       # build + export + 3 checks + the jam archive (dist/), prints EXPORT PASS or EXPORT FAIL
bun run export:macos --no-zip              # no archive step
bun run export:macos --expect "game ready" # the debug-build log must contain this text
bun run export:macos --no-smoke            # build + export + pack check only; the app is NOT run
bun run export:macos --frames 600          # how long the debug-build run lasts (default 300 frames)
```

Output: `out/<project name>.app` (gitignored; universal arm64 + x86_64; about 140 MB).
The command needs, once per machine:

1. **A configured GodotJS editor binary** (`bun tools/config.ts set <path>`; see `docs/DAILY.md`).
2. **The ETC2/ASTC setting** in `project.godot` (Godot refuses a universal or arm64 export without it). The starter has it:
   ```
   [rendering]
   textures/vram_compression/import_etc2_astc=true
   ```
3. **`export_presets.cfg`** with a `macOS` preset (the starter has it). Its exclude filter hides tooling from the pack
   (`tools/*, typings/*, docs/*, tests/*, bun/*, node_modules/*, out/*, .vscode/*, .githooks/*, README.md, bun.lock,
   tsconfig.json, package.json, .env*`). It must NOT contain `*.ts`: the engine loader finds the compiled bundle through the `.ts`
   path, so excluding `.ts` leaves the game without its scripts (the command refuses such a preset).
   Change `application/bundle_identifier` from the `com.example.*` placeholder before you ship.
4. **The export templates** (next section).

### Install the export templates

Godot's own downloadable templates do not contain the GodotJS runtime. Use the ones in the GodotJS release,
the same release as your editor binary. Verified on 4.6.1 (the result is byte-for-byte the same size as a working install):

```sh
mkdir -p /tmp/godotjs-templates && cd /tmp/godotjs-templates
gh release download v1.1.0.beta1-4.6.1 -R godotjs/GodotJS -p 'macos-template-app-4.6.1-qjs-ng.zip'
unzip -q macos-template-app-4.6.1-qjs-ng.zip && cd macos-template-app-4.6.1-qjs-ng
zip -qry macos.zip macos_template.app            # Godot wants macos.zip with macos_template.app at the top
D="$HOME/Library/Application Support/Godot/export_templates/4.6.1.stable"
mkdir -p "$D" && cp macos.zip "$D/" && echo 4.6.1.stable > "$D/version.txt"
```

The folder name and `version.txt` must equal the first part of `godot --version` (`4.6.1.stable`). The zip holds
`godot_macos_release.universal` and `godot_macos_debug.universal`. Use the `qjs-ng` asset if your editor is the `qjs-ng`
flavour (`jsc` and `v8` flavours exist; the template flavour must match the engine flavour the game was built for).

### What the export check proves (and does not)

The command prints one PASS or FAIL line per check and an overall `EXPORT PASS` / `EXPORT FAIL` (exit code 0 / 1).

| Check | What it does | Shows | Does NOT show |
|---|---|---|---|
| **bundle in pack** (always) | Reads the file table of the exported `.pck`: every `*.ts.remap` has its compiled `.js` in the pack, byte-identical in size to the build output; no tooling files (`tools/`, `typings/`, `docs/`, ...) leaked in | The scripts really are inside the app, and the pack holds what the build produced | That the engine can run them |
| **release app runs the game** (skipped by `--no-smoke`) | Copies the exported release `.app` to a temp directory, puts an `override.cfg` beside its executable that autoloads `tools/smoke/probe.gd` (a file outside the app and the pack), runs it `--headless`, and reads a JSON report the probe writes after 15 frames: exit status 0, `debug_build` false, the main scene loaded, every `.ts` script node found in the tree can instantiate, and no `ERROR` / `WARNING` / `[jsb]` line on the console | The release template itself, with your pack, loads the main scene and its GodotJS scripts and runs frames. The shipped `.app` is never modified; your game's scripts are not touched | Anything about gameplay after frame 15, rendering (headless has no window), a game that attaches scripts later than 15 frames (it prints a note), or the signed/notarized app (this tests the unsigned one) |
| **debug app log** (skipped by `--no-smoke`) | Exports a DEBUG build of the same project to a temp directory, runs it headless for `--frames` frames, and reads the console: engine started, exit 0, no `ERROR` / `SCRIPT ERROR` / `[jsb][Error]` / `Failed loading` line, and (if `--expect "text"` is given) the text appears | Your own JS logging (the release template prints no JS console, the debug one does): use `--expect` to assert a line your game prints | That the RELEASE binary behaves the same; it is a different binary running the same pack |

Notes on honesty:

- Godot's exit status is **not** a failure signal here. With a broken pack (scripts excluded) both binaries still exit 0 and
  only print `ERROR: Failed loading scene` lines; that is why the checks read the console and the probe, not just the exit code.
  This was tried: with `src/scripts/main.ts` excluded, all three checks printed FAIL.
- Running the app runs your game headless for a moment. If your game writes to `user://` at startup, it will write there during the check.
- `--no-smoke` runs nothing. Its `EXPORT PASS` means only "the pack looks right".
- Not checked at all: that the app opens a window and renders on a real machine, audio, input, controller support.
  Open `out/<name>.app` yourself before you ship.
- A release build prints no JS console, so to measure something inside the shipped app, have the game WRITE its numbers to a file
  (`FileAccess.open(OS.get_environment("MY_PROBE_OUT"), FileAccess.ModeFlags.WRITE)`) and run the exported executable with that
  variable set. `starter/tests/effect-time/export-run.sh` does this with a timer probe (release app, headless): timers and
  `Effect.sleep` behave as in the editor build, about 10% late (`docs/design/effect-time.md`, row 8). Repo-only (needs a starter checkout).

## 2. What an unsigned app looks like to a player

The exported app has only the ad-hoc "linker" signature of the template (`codesign -dv` shows `Signature=adhoc`,
`flags=adhoc,linker-signed`, `Info.plist=not bound`, `Sealed Resources=none`), and `spctl --assess --type execute` says
`rejected, source=no usable signature` (checked on the exported app). Consequences:

- An app you run from the folder it was built in, or copy yourself, opens normally (it has no quarantine flag).
- An app that arrives by download, browser, chat or AirDrop gets the `com.apple.quarantine` flag and Gatekeeper blocks it
  (the exact dialog wording varies by macOS version; UNVERIFIED here, no quarantined copy was opened).
  On recent macOS versions there is no "Open anyway" on right-click: the player has to open **System Settings > Privacy & Security**,
  scroll to the message about the blocked app, and click **Open Anyway** (macOS 15 and later), or on older versions right-click the app and choose **Open**.
  Players who know the terminal can run `xattr -dr com.apple.quarantine /path/to/Game.app`.
- Apple Silicon Macs also require some signature to run native arm64 code; the template's linker signature satisfies that for a local build.
  If you modify the bundle after export (add files, edit `Info.plist`), the ad-hoc signature no longer matches the contents; sign again (below).

For friends and playtesters, an unsigned zip plus those instructions is enough. For anyone else, sign and notarize.

## 3. Sign and notarize (UNVERIFIED: no certificate was available)

### You need
- An **Apple Developer Program** membership (paid, per year). Distribution outside the App Store uses a **Developer ID Application**
  certificate (create it in the developer portal or Xcode; it lands in your Keychain). `security find-identity -v -p codesigning` lists it as
  `Developer ID Application: Your Name (TEAMID)`.
- For notarization, either an **app-specific password** for your Apple ID (appleid.apple.com), or an **App Store Connect API key** (key id, issuer id, `.p8` file).
- Xcode command line tools (`xcrun notarytool` and `xcrun stapler`; both are present on the machine that wrote this page).

### Entitlements: what is certain and what is inferred
Hardened runtime is mandatory for notarization (Apple). Under it, these entitlements exist (Godot's macOS export docs list them with the preset names in brackets):

| Entitlement | Preset option | Needed by this project? |
|---|---|---|
| `com.apple.security.cs.allow-jit` | `codesign/entitlements/allow_jit_code_execution` | **Inferred: no for the `qjs-ng` flavour.** QuickJS-NG is an interpreter and generates no machine code. **A V8 flavour would need it** (V8 JITs). Not tested either way |
| `com.apple.security.cs.allow-unsigned-executable-memory` | `.../allow_unsigned_executable_memory` | Inferred: no for `qjs-ng`; yes-likely for V8 |
| `com.apple.security.cs.disable-library-validation` | `.../disable_library_validation` | Only if you ship GDExtensions or other libraries signed by a different team. Not needed for the stock template (no external dylibs) |
| `com.apple.security.cs.allow-dyld-environment-variables` | `.../allow_dyld_environment_variables` | No |
| `com.apple.security.get-task-allow` | `.../debugging` | **Certain:** must be OFF; Godot's docs say notarization fails with `Debugging` enabled |

Certain: hardened runtime is required, `Debugging` must be off, an app with no external libraries needs none of the `cs.*` exceptions in Godot's own documentation.
Inference: that the quickjs-ng GodotJS template needs none either. **Test it:** sign with no `cs.*` entitlements, run the signed app, and watch for a
crash at startup (a hardened-runtime violation kills the process; `Console.app` shows a `CODESIGNING` or `EXC_BAD_ACCESS` report). If it crashes, add
`allow-jit` and `allow-unsigned-executable-memory` and retry. Unsandboxed distribution outside the App Store does not need the App Sandbox entitlements.

### Path A: let Godot sign and notarize during export (preset options)
Edit `export_presets.cfg` (or the editor's Export dialog, which writes it). Preset option names in 4.6.1 (read from the engine binary):

| Preset option | Value |
|---|---|
| `codesign/codesign` | `0` disabled, `1` built-in (ad-hoc only, Gatekeeper still blocks), `2` rcodesign, `3` Xcode codesign. Use `3` |
| `codesign/identity` | the certificate Common Name, e.g. `Developer ID Application: Your Name (TEAMID)` |
| `codesign/timestamp` | `true` (notarization requires a secure timestamp) |
| `codesign/identity_type` | the kind of identity (the editor offers a list; choose the Developer ID one; exact enum values not exercised) |
| `codesign/entitlements/...` | leave the `cs.*` ones off first (above); `debugging` off |
| `notarization/notarization` | `0` disabled, `1` Xcode notarytool, `2` rcodesign. Use `1` |
| `notarization/apple_id_name`, `notarization/apple_id_password` | Apple ID e-mail and the app-specific password (keep out of git: put them in the editor's export settings, not in a committed file), or |
| `notarization/api_uuid`, `notarization/api_key`, `notarization/api_key_id` | the App Store Connect API issuer, `.p8` path and key id |
| `application/bundle_identifier` | your own reverse-DNS id (not `com.example.*`) |

(Option names are read from the engine binary's option list and Godot's docs; none of them was exercised. There is no separate hardened-runtime switch in the list; Godot's docs describe hardened runtime through the entitlement options, so confirm with `codesign -dvv` that the signed app shows `flags=0x10000(runtime)`.)
Keep secrets out of the repository: `export_presets.cfg` is committed, so either leave the credentials unset there and give them through the editor,
or use Path B. `bun run export:macos` itself exports with signing as the preset says; the smoke checks then run the signed app (an `override.cfg`
in the copy invalidates the copy's signature; if the checks fail only on a signed app, run with `--no-smoke` and test by hand).

### Path B: sign and notarize by hand (recommended: nothing secret in the project)
Export unsigned first (`bun run export:macos`), then, with `APP="out/Your Game.app"`:

```sh
ID="Developer ID Application: Your Name (TEAMID)"
cat > /tmp/entitlements.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <!-- start with this empty dict; add the cs.* keys from section above only if the signed app crashes at launch -->
</dict></plist>
EOF
# 1. sign: hardened runtime, secure timestamp. The executable inside, then the bundle.
codesign --force --timestamp --options runtime --entitlements /tmp/entitlements.plist \
  --sign "$ID" "$APP/Contents/MacOS/"*
codesign --force --timestamp --options runtime --entitlements /tmp/entitlements.plist --sign "$ID" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"          # must print "valid on disk"

# 2. zip for upload (notarytool takes a zip, dmg or pkg; ditto keeps the bundle intact)
ditto -c -k --keepParent "$APP" /tmp/Game.zip

# 3. notarize and wait; either credential style:
xcrun notarytool submit /tmp/Game.zip --apple-id you@example.com --team-id TEAMID --password "app-specific-password" --wait
#    or: xcrun notarytool submit /tmp/Game.zip --key AuthKey.p8 --key-id KEYID --issuer ISSUER-UUID --wait
#    on "Invalid": xcrun notarytool log <submission-id> ...  (same credentials) lists the reason

# 4. staple the ticket into the app so it opens offline, then check
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute -vv "$APP"                     # expect: accepted, source=Notarized Developer ID
```

### Distribute
- **zip**: `ditto -c -k --keepParent "$APP" Game-1.0-macos.zip` AFTER stapling. Plain `zip` can drop attributes; `ditto` is the safe one. Simplest and enough.
- **DMG** (nicer to open; Godot's docs say its own DMG support exists only when exporting from macOS):
  `hdiutil create -volname "Your Game" -srcfolder "$APP" -ov -format UDZO Game-1.0.dmg`, then `codesign --sign "$ID" --timestamp Game-1.0.dmg`,
  `xcrun notarytool submit Game-1.0.dmg ... --wait`, `xcrun stapler staple Game-1.0.dmg`.
- Test as a player would: download the file through a browser (so it gets the quarantine flag) on another Mac, open it, confirm no warning.

## 4. Checklist (one page)

macOS release
- [ ] `application/bundle_identifier` is yours; version strings (`application/short_version`, `application/version`) bumped
- [ ] export templates installed for your engine version (section 1); `bun run export:macos` prints `EXPORT PASS`
- [ ] opened `out/<name>.app` by hand once: window, input, audio, a save/load round trip
- [ ] Developer ID Application certificate in the Keychain (`security find-identity -v -p codesigning`)
- [ ] hardened runtime on (`codesign -dvv` shows `runtime`); `Debugging` entitlement off; no `cs.*` exceptions unless the signed app crashed without them
- [ ] `codesign --verify --deep --strict` passes
- [ ] `notarytool submit ... --wait` says `Accepted` (if `Invalid`, read `notarytool log`)
- [ ] `stapler staple` and `stapler validate` pass; `spctl --assess` says `Notarized Developer ID`
- [ ] zip made with `ditto` (or DMG signed, notarized and stapled) AFTER stapling
- [ ] downloaded through a browser on a second Mac and opened without a Gatekeeper warning
- [ ] no secrets (Apple ID password, `.p8`) in git
- [ ] if you ship unsigned: the download page tells players about System Settings > Privacy & Security > Open Anyway

## 5. Windows, Linux, web, mobile: what exists (GodotJS release `v1.1.0.beta1-4.6.1`)

Asset list from `gh release view v1.1.0.beta1-4.6.1 -R godotjs/GodotJS --json assets` (sizes in MB, zipped):

| Platform | Assets | Flavours | Notes |
|---|---|---|---|
| macOS | `macos-template-app-*` 102.8 / 125.1 / 101.2; `macos-template_release-*` 50.1 / 61.1 / 49.3; `macos-template_debug-*` 52.7 / 64.0 / 51.8; editors | `qjs-ng` / `v8` / `jsc` | the `-app` zip is the one to install (above); it contains both universal binaries |
| Windows | `windows-template_release-*` 32.5 (qjs-ng) / 39.1 (v8); `windows-template_debug-*` 37.5 / 45.0; `windows-editor-*` 83.9 / 91.5 | `qjs-ng`, `v8` (no jsc) | x86_64 only; real templates (a GUI `.exe`, a `.console.exe`, and the two D3D12 DLLs) |
| Linux | `linux-template_release-*` 78.7 (qjs-ng) / 85.9 (v8); `linux-template_debug-*` 78.7 / 85.9; `linux-editor-*` 78.7 / 85.9 | `qjs-ng`, `v8` | x86_64 only. **The "template" zips contain `godot.linuxbsd.editor.x86_64`, an editor build (162 MB), not a `template_release` binary.** All three Linux assets of one flavour have the same size; their contents differ by hash. No arm64 Linux |
| Web | `web[-dlink][-nothreads]-template_{debug,release}-*` 18.6 to 20.3 | `qjs-ng`, `browser` (uses the browser's JS engine) | threads / no-threads / dlink variants; never exported or run here |
| Android | `android-template_{debug,release}-*` 76.4 to 108.8 | `qjs-ng`, `v8` | never exported here |
| iOS | `ios-template_{debug,release}-*` 48.6 to 68.6 | `qjs-ng`, `v8`, `jsc` | never exported here; needs Xcode and an Apple developer account |

Missing: Windows arm64, Linux arm64, and a true Linux export template (see above). Nothing in the starter has a preset for these platforms,
because none was run; the recipe below is what was done and checked from a Mac.

### Windows from a Mac with the installed-template route (exported and inspected; NOT run)

The starter's `export_presets.cfg` has a `Windows Desktop` preset (`custom_template/*` empty = use installed templates, `embed_pck=false`, no rcedit).
Install the two `qjs-ng` assets (`windows-template_release-4.6.1-qjs-ng.zip`, `windows-template_debug-4.6.1-qjs-ng.zip`, about 32 and 37 MB zipped) by
copying, into `~/Library/Application Support/Godot/export_templates/4.6.1.stable/` (next to `macos.zip`, same `version.txt`), with these names:

| asset file | install as |
|---|---|
| `godot.windows.template_release.x86_64.exe` | `windows_release_x86_64.exe` |
| `godot.windows.template_release.x86_64.console.exe` | `windows_release_x86_64_console.exe` |
| `godot.windows.template_debug.x86_64.exe` | `windows_debug_x86_64.exe` |
| `godot.windows.template_debug.x86_64.console.exe` | `windows_debug_x86_64_console.exe` |

Then `godot --headless --path . --export-release "Windows Desktop" out/windows/Game.exe` gives `Game.exe` (83.4 MB) and `Game.pck` (a debug export also gives `Game.console.exe`).
Zip both files (and, to be safe for the D3D12 renderer, `D3D12Core.dll` and `d3d12SDKLayers.dll` from the asset; the export does not copy them). Check the pack with
`bun -e 'import {readPck} from "./tools/pck.ts"; console.log(readPck("out/windows/Game.pck").entries.map(e=>e.path))'`.
Details and the unverified list: `docs/design/jam-shipping.md`.

### Recipe: export for Windows or Linux with a custom template (exported and inspected; NOT run)
Godot's export presets accept `custom_template/debug` and `custom_template/release` (absolute paths), so the templates need not be installed in the
read-only Godot template folder. Download and unzip the matching assets into their own folders, then add a preset to `export_presets.cfg`
(same `exclude_filter` as the macOS preset, no `*.ts`):

```
[preset.1]
name="Windows Desktop"
platform="Windows Desktop"
runnable=true
export_filter="all_resources"
exclude_filter="<same as the macOS preset>"
export_path="out/windows/Game.exe"

[preset.1.options]
custom_template/debug="/abs/path/windows-template_debug-4.6.1-qjs-ng/godot.windows.template_debug.x86_64.exe"
custom_template/release="/abs/path/windows-template_release-4.6.1-qjs-ng/godot.windows.template_release.x86_64.exe"
binary_format/embed_pck=false
binary_format/architecture="x86_64"
codesign/enable=false
application/modify_resources=false   # no rcedit/wine on a Mac; the exe keeps the template's icon and version info
```

Linux is the same with `platform="Linux"`, `binary_format/architecture="x86_64"` and the two `custom_template` paths pointing at the
`godot.linuxbsd.editor.x86_64` files. Then `godot --headless --path . --export-release "Windows Desktop" out/windows/Game.exe`.
Result of trying this from a Mac with the `qjs-ng` assets: both exports **succeeded** (`Game.exe` 83.4 MB + `Game.pck`; Linux binary 161.9 MB + `Game.pck`).
Both `.pck` files were read with `tools/pck.ts`: format 3, the compiled bundle (`.godot/GodotJS/.../main.js`) is inside, byte-identical in size to
the build output, and the `.ts.remap` is present. The two packs are byte-identical to each other.

**Not verified: neither the Windows nor the Linux build was run** (no Windows or Linux machine was available). Open questions:
the Linux "template" is an editor binary used as a game runtime (it may still run the game from the `.pck` beside it, or it may open the editor or project manager;
unknown); the Windows console wrapper and D3D12 DLLs were not copied by the export (not needed for a GL Compatibility project, unknown for a Forward+ one);
Windows signing (`signtool`), SmartScreen behaviour and Linux distribution (AppImage, Flatpak) were not looked at.
Copy the `.exe` or the Linux binary together with its `.pck` (same base name) to the target machine and run it there before promising anything.
