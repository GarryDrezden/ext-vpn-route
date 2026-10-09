// Read-only post-install verification: native host ping + getStateManifest path.
// Never calls upsertRule, deleteRule, or resetRules.
//
// Usage: node scripts/verify-browser-integration-readonly.js [path-to-host.exe]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_EXE, TEST_PIPE_VARIABLE, processRuntime, runHost, ALLOWED_ORIGIN } from "./build-native-host.js";
import { createNativeStateProvider } from "../src/extension/state/native-state-provider.js";

const EXPECTED_CAPS = [
  "browserClientHeartbeat",
  "browserExplicitSocks",
  "browserRoutingState",
  "vpnEgressReadiness",
  "browserRoutingWrite"
];

async function main() {
  const exe = process.argv[2] ? path.resolve(process.argv[2]) : HOST_EXE;
  const env = { ...process.env };
  delete env[TEST_PIPE_VARIABLE];

  const ping = { protocolVersion: 1, requestId: "install-verify-ping", command: "ping" };
  const pingResult = await runHost([ping], [ALLOWED_ORIGIN, "--parent-window=0"], exe, env);
  const pong = pingResult.responses[0];
  if (pingResult.code !== 0 || !pong?.ok || pong.result?.command !== "pong") {
    throw new Error("Native host ping failed.");
  }
  console.log("PASS  native host ping");

  const provider = createNativeStateProvider({
    runtime: processRuntime(exe, env),
    hostName: "com.vpnroute.browser"
  });
  const result = await provider.getSnapshot();
  if (!result.ok) {
    if (result.transport === "AVAILABLE" && result.service === "UNAVAILABLE") {
      console.warn("WARN  Service UNAVAILABLE; host bridge OK (read-only verify partial).");
      return;
    }
    throw new Error("getStateManifest path failed: " + (result.error?.message || result.error?.code || "unknown"));
  }

  const integration = result.integration;
  const api = integration?.integrationApiVersion;
  console.log("integrationApiVersion:", api === null || api === undefined ? "legacy" : ("v" + api));

  const caps = new Set(integration?.capabilities ?? []);
  for (const cap of EXPECTED_CAPS) {
    if (!caps.has(cap)) throw new Error("Missing capability: " + cap);
  }
  console.log("PASS  capabilities:", EXPECTED_CAPS.join(", "));
  console.log("PASS  read-only verify (no write RPCs)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}
