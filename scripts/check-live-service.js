// Read-only check of the live chain: production native host exe -> real VPN Route Service pipe.
// Sends getStateManifest (and getStatePage while rules remain) exactly as the extension does.
// Never writes state, never touches VPN, proxy settings or the registry.
//
// Usage: node scripts/check-live-service.js [path-to-host.exe]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_EXE, TEST_PIPE_VARIABLE, processRuntime } from "./build-native-host.js";
import { createNativeStateProvider } from "../src/extension/state/native-state-provider.js";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exe = process.argv[2] ? path.resolve(process.argv[2]) : HOST_EXE;
  const env = { ...process.env };
  delete env[TEST_PIPE_VARIABLE];
  const provider = createNativeStateProvider({ runtime: processRuntime(exe, env), hostName: "com.vpnroute.browser" });
  const result = await provider.getSnapshot();
  const summary = {
    ok: result.ok,
    transport: result.transport,
    service: result.service,
    state: result.state,
    browserProxy: result.browserProxy,
    identity: result.identity,
    ruleCount: result.ok ? result.snapshot.state.rules.length : null,
    defaultRoute: result.ok ? result.snapshot.state.defaultRoute : null,
    stats: result.stats,
    error: result.ok ? null : result.error
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
