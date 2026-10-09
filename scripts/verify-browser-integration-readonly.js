// Read-only post-install verification: native host ping + getStateManifest path.
// Never calls upsertRule, deleteRule, or resetRules.
//
// Usage:
//   node scripts/verify-browser-integration-readonly.js [path-to-host.exe]
//   node scripts/verify-browser-integration-readonly.js --require-browser-routing-push [path-to-host.exe]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_EXE, TEST_PIPE_VARIABLE, processRuntime, runHost, ALLOWED_ORIGIN } from "./build-native-host.js";
import { createNativeStateProvider } from "../src/extension/state/native-state-provider.js";

export const EXPECTED_CAPS = Object.freeze([
  "browserClientHeartbeat",
  "browserExplicitSocks",
  "browserRoutingState",
  "vpnEgressReadiness",
  "browserRoutingWrite"
]);

export const BROWSER_ROUTING_PUSH_CAP = "browserRoutingPush";
export const REQUIRE_PUSH_FLAG = "--require-browser-routing-push";

/** @param {string[]} argv process.argv */
export function parseVerifyArgv(argv) {
  let requireBrowserRoutingPush = false;
  let exePath = null;
  for (const arg of argv.slice(2)) {
    if (arg === REQUIRE_PUSH_FLAG) {
      requireBrowserRoutingPush = true;
    } else if (!arg.startsWith("-")) {
      exePath = arg;
    }
  }
  return { requireBrowserRoutingPush, exePath };
}

/**
 * @param {Iterable<string>} capabilities
 * @param {{ requireBrowserRoutingPush?: boolean }} options
 */
export function checkIntegrationCapabilities(capabilities, options = {}) {
  const caps = new Set(capabilities);
  for (const cap of EXPECTED_CAPS) {
    if (!caps.has(cap)) {
      return { ok: false, error: "Missing capability: " + cap };
    }
  }
  const hasPush = caps.has(BROWSER_ROUTING_PUSH_CAP);
  if (options.requireBrowserRoutingPush && !hasPush) {
    return { ok: false, error: "Missing capability: " + BROWSER_ROUTING_PUSH_CAP };
  }
  return {
    ok: true,
    hasPush,
    pushOptionalMissing: !options.requireBrowserRoutingPush && !hasPush
  };
}

async function main() {
  const { requireBrowserRoutingPush, exePath } = parseVerifyArgv(process.argv);
  const exe = exePath ? path.resolve(exePath) : HOST_EXE;
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

  const capCheck = checkIntegrationCapabilities(integration?.capabilities ?? [], { requireBrowserRoutingPush });
  if (!capCheck.ok) {
    throw new Error(capCheck.error);
  }

  const listed = [...EXPECTED_CAPS];
  if (capCheck.hasPush) listed.push(BROWSER_ROUTING_PUSH_CAP);
  console.log("PASS  capabilities:", listed.join(", "));
  if (capCheck.pushOptionalMissing) {
    console.warn("WARN  optional capability missing: " + BROWSER_ROUTING_PUSH_CAP + " (older Service; full 1.0.0 install requires it)");
  }
  console.log("PASS  read-only verify (no write RPCs)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}
