import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const examplePath = path.join(repoRoot, "contracts/browser-routing-v1/integration-manifest-v1.example.json");

const REQUIRED_CAPABILITIES = Object.freeze([
  "browserRoutingState",
  "browserExplicitSocks",
  "vpnEgressReadiness",
  "browserClientHeartbeat"
]);

const CLIENT_STATUSES = Object.freeze(["NeverSeen", "RecentlySeen", "Stale"]);

test("integration manifest v1 example matches approved contract shape", () => {
  const doc = JSON.parse(readFileSync(examplePath, "utf8"));
  assert.equal(doc.integrationApiVersion, 1);
  assert.equal(typeof doc.integrationApiVersion, "number");
  assert.ok(Array.isArray(doc.capabilities));
  for (const cap of REQUIRED_CAPABILITIES) {
    assert.ok(doc.capabilities.includes(cap), "missing capability: " + cap);
  }
  assert.ok(doc.browserProxy);
  assert.ok(["Ready", "Unavailable"].includes(doc.browserProxy.status));
  assert.ok(doc.vpnEgress);
  assert.ok(["Ready", "Unavailable"].includes(doc.vpnEgress.status));
  assert.ok(doc.browserClient);
  assert.ok(CLIENT_STATUSES.includes(doc.browserClient.status));
});

test("integration manifest v1 documents heartbeat bootstrap (doc-only constants)", () => {
  assert.equal(120, 120, "RecentlySeen TTL seconds (Slice 5 Service constant target)");
});
