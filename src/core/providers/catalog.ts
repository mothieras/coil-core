import type { MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

let cached: MutableModels | undefined;

/** Lazily builds the shared collection so importing the core never touches provider config. */
export function getModelsCollection(): MutableModels {
  cached ??= builtinModels();
  return cached;
}
