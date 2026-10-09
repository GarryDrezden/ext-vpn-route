// Build-time state source: Native. Copied to extension/state/source.js by `npm run build:extension:native`.

import { EXTENSION_VERSION, NATIVE_HOST_NAME } from "../runtime/config.js";
import { createBrowserRoutingWriter } from "./browser-routing-writer.js";
import { createNativeStateProvider } from "./native-state-provider.js";

export const STATE_SOURCE = "Native";

export function createStateSource(chromeApi) {
  const extensionVersion = typeof chromeApi.runtime.getManifest === "function"
    ? chromeApi.runtime.getManifest().version
    : EXTENSION_VERSION;
  const runtime = chromeApi.runtime;
  const provider = createNativeStateProvider({
    runtime,
    hostName: NATIVE_HOST_NAME,
    extensionVersion
  });
  const writer = createBrowserRoutingWriter({ runtime, hostName: NATIVE_HOST_NAME });
  return Object.freeze({
    mode: STATE_SOURCE,
    fixture: null,
    provider,
    writer,
    builtInState: null
  });
}
