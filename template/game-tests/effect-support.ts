// Lets `it.effect` in the engine kit run Effects. Import it for its side effect: `import "../effect-support";`
// (Effect projects only: create-godotjs-bun leaves this file out of the --no-effect template.)
import * as Effect from "effect/Effect";
import { useEffectRunner } from "../tools/test-kit";

useEffectRunner((effect) => Effect.runPromise(effect));
