// Build-time state source: Native. Copied to extension/state/source.js by `npm run build:extension:native`.

import { NATIVE_HOST_NAME } from "../runtime/config.js";
import { createNativeStateProvider } from "./native-state-provider.js";

export const STATE_SOURCE = "Native";

export function createStateSource(chromeApi) {
  return Object.freeze({
    mode: STATE_SOURCE,
    fixture: null,
    provider: createNativeStateProvider({ runtime: chromeApi.runtime, hostName: NATIVE_HOST_NAME }),
    builtInState: null
  });
}
