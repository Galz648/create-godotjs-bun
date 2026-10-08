// Build-time checks for the plugin. No Godot process. The sections live in ./self-check/, one file per area;
// importing a section runs it, in this order, so the output is one stream.
import { fails } from "./self-check/harness.ts";
import "./self-check/exports.ts";
import "./self-check/registration.ts";
import "./self-check/diagnostics.ts";
import "./self-check/abort-guards.ts";
import "./self-check/value-checks.ts";
import "./self-check/leak-checks.ts";
import "./self-check/scenes.ts";
import "./self-check/stored.ts";
import "./self-check/rewrites.ts";
import "./self-check/guards.ts";
import "./self-check/scene-guards.ts";
import "./self-check/session.ts";
import "./self-check/bundle.ts";

if (fails.length) {
  console.log(`FAIL self-check ${fails.join(",")}`);
  process.exit(1);
}
console.log("PASS self-check");
