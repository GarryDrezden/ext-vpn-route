import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isCanonicalHost, normalizeHost, validateBrowserRoutingState } from "../../../src/domain/browser-routing/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const vectorsPath = join(root, "contracts/browser-routing-v1/golden-vectors.json");
const vectorsBytes = readFileSync(vectorsPath);
const vectors = JSON.parse(vectorsBytes.toString("utf8"));
const gatewayRoot = process.env.VPN_GATEWAY_ROOT || resolve(root, "../vpn-gateway");
const gatewayCopy = join(gatewayRoot, "tests/contracts/browser-routing-v1/golden-vectors.json");

const codesOf = (issues) => [...new Set(issues.map((entry) => entry.code))].sort();

test("golden vectors cover hosts and states", () => {
  assert.equal(vectors.contract, "BrowserRoutingStateV1");
  assert.ok(vectors.hosts.length >= 30);
  assert.ok(vectors.states.length >= 15);
});

for (const vector of vectors.hosts) {
  test("host vector " + JSON.stringify(vector.input), () => {
    const result = normalizeHost(vector.input);
    if (vector.canonical === null) {
      assert.equal(result.ok, false, "expected rejection");
    } else {
      assert.equal(result.ok, true, result.ok ? "" : result.error.code);
      assert.equal(result.host, vector.canonical);
      assert.equal(isCanonicalHost(vector.canonical), true);
    }
    // The Service accepts exactly the inputs that are already canonical.
    assert.equal(isCanonicalHost(vector.input), vector.canonical === vector.input);
  });
}

for (const vector of vectors.states) {
  test("state vector " + vector.name, () => {
    const result = validateBrowserRoutingState(vector.state);
    assert.equal(result.ok, vector.js.valid);
    assert.deepEqual(codesOf(result.issues), vector.js.codes);
  });
}

test("vpn-gateway keeps a byte-identical copy of the golden vectors", { skip: !existsSync(gatewayCopy) && "vpn-gateway checkout not found" }, () => {
  assert.ok(readFileSync(gatewayCopy).equals(vectorsBytes), "copy differs: " + gatewayCopy);
});
