import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_ROUTING_PUSH_CAP,
  EXPECTED_CAPS,
  REQUIRE_PUSH_FLAG,
  checkIntegrationCapabilities,
  parseVerifyArgv
} from "../scripts/verify-browser-integration-readonly.js";

const FULL_CAPS = [...EXPECTED_CAPS, BROWSER_ROUTING_PUSH_CAP];

test("parseVerifyArgv: exe path only", () => {
  const parsed = parseVerifyArgv(["node", "verify.js", "C:\\host.exe"]);
  assert.equal(parsed.exePath, "C:\\host.exe");
  assert.equal(parsed.requireBrowserRoutingPush, false);
});

test("parseVerifyArgv: require push flag", () => {
  const parsed = parseVerifyArgv(["node", "verify.js", REQUIRE_PUSH_FLAG, "host.exe"]);
  assert.equal(parsed.requireBrowserRoutingPush, true);
  assert.equal(parsed.exePath, "host.exe");
});

test("checkIntegrationCapabilities: base caps required", () => {
  const ok = checkIntegrationCapabilities(FULL_CAPS, {});
  assert.equal(ok.ok, true);
  assert.equal(ok.hasPush, true);

  const missing = checkIntegrationCapabilities(["browserRoutingState"], {});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /browserClientHeartbeat/);
});

test("checkIntegrationCapabilities: push optional by default", () => {
  const caps = [...EXPECTED_CAPS];
  const result = checkIntegrationCapabilities(caps, {});
  assert.equal(result.ok, true);
  assert.equal(result.hasPush, false);
  assert.equal(result.pushOptionalMissing, true);
});

test("checkIntegrationCapabilities: push required when flagged", () => {
  const caps = [...EXPECTED_CAPS];
  const fail = checkIntegrationCapabilities(caps, { requireBrowserRoutingPush: true });
  assert.equal(fail.ok, false);
  assert.match(fail.error, /browserRoutingPush/);

  const pass = checkIntegrationCapabilities(FULL_CAPS, { requireBrowserRoutingPush: true });
  assert.equal(pass.ok, true);
  assert.equal(pass.hasPush, true);
});
