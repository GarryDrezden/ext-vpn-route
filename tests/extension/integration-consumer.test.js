import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compilePacScript } from "../../src/pac/index.js";
import {
  SUPPORTED_INTEGRATION_API_MAJOR,
  parseIntegrationManifest,
  samePacApplyFingerprint,
  pacApplyFingerprint
} from "../../src/extension/state/integration-manifest.js";
import {
  Decision,
  createRoutingCoordinator
} from "../../src/extension/runtime/routing-coordinator.js";
import { createNativeStateProvider } from "../../src/extension/state/native-state-provider.js";
import { createProxyController } from "../../src/extension/runtime/proxy-controller.js";
import {
  GEN_A,
  INTEGRATION_V1,
  READY,
  UNAVAILABLE,
  createFakeNativeRuntime,
  createFakeProxy,
  createFakeStorage,
  fakeNow,
  nativeHostServing,
  routingState
} from "./fakes.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = path.join(repoRoot, "contracts/browser-routing-v1/integration-manifest-v1.example.json");

function serving(revision, options = {}) {
  return nativeHostServing(routingState(revision), options);
}

function setup(options = {}) {
  const proxy = createFakeProxy();
  const sourceStorage = createFakeStorage();
  const host = { handler: options.handler || serving(42, { integration: INTEGRATION_V1 }) };
  const runtime = createFakeNativeRuntime((name, message) => host.handler(name, message));
  const provider = createNativeStateProvider({
    runtime,
    hostName: "com.vpnroute.browser",
    timeoutMs: 500,
    now: fakeNow,
    extensionVersion: "0.1.0",
    nativeHostVersion: "0.5.0"
  });
  const controller = createProxyController({ proxy, storage: createFakeStorage(), compile: compilePacScript, now: fakeNow });
  const coordinator = createRoutingCoordinator({
    mode: "Native",
    controller,
    provider,
    storage: sourceStorage,
    now: fakeNow
  });
  return { proxy, runtime, provider, coordinator, host, sourceStorage };
}

describe("integration manifest parser", () => {
  test("fixture example matches v1 semantics", () => {
    const doc = JSON.parse(readFileSync(fixturePath, "utf8"));
    const parsed = parseIntegrationManifest(doc);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.integration.integrationApiVersion, 1);
    assert.equal(parsed.integration.mode, "V1");
  });

  test("legacy Phase 5 manifest without integrationApiVersion is compatible", () => {
    const parsed = parseIntegrationManifest({
      schemaVersion: 1,
      stateGeneration: GEN_A,
      revision: 0,
      defaultRoute: "Direct",
      ruleCount: 0,
      pageBudgetBytes: 520192,
      browserProxy: UNAVAILABLE
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.integration.mode, "LEGACY_PHASE5");
    assert.equal(parsed.integration.integrationApiVersion, null);
  });

  test("unsupported major is incompatible", () => {
    const parsed = parseIntegrationManifest({
      schemaVersion: 1,
      integrationApiVersion: 2,
      serviceVersion: "9.9.9",
      capabilities: ["browserRoutingState"],
      stateGeneration: GEN_A,
      revision: 0,
      defaultRoute: "Direct",
      ruleCount: 0,
      pageBudgetBytes: 520192,
      browserProxy: UNAVAILABLE,
      vpnEgress: { status: "Unavailable", interfaceIndex: null, interfaceName: null },
      browserClient: { status: "NeverSeen", lastSeenUtc: null }
    });
    assert.equal(parsed.ok, false);
    assert.match(parsed.message, /Extension supports: 1/);
  });

  test("serviceVersion does not gate compatibility", () => {
    const parsed = parseIntegrationManifest({
      ...JSON.parse(readFileSync(fixturePath, "utf8")),
      serviceVersion: "totally-different-version"
    });
    assert.equal(parsed.ok, true);
  });

  test("unknown capability token is ignored", () => {
    const parsed = parseIntegrationManifest({
      ...JSON.parse(readFileSync(fixturePath, "utf8")),
      capabilities: [...INTEGRATION_V1.capabilities, "futureCapability"]
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.integration.hasCapability("futureCapability"), true);
    assert.equal(parsed.integration.hasCapability("browserRuleWrite"), false);
  });
});

describe("heartbeat bootstrap", () => {
  test("first getManifest after provider creation has no client params", async () => {
    const { runtime, provider } = setup();
    await provider.getSnapshot();
    const manifestCall = runtime.calls.filter((c) => c.message.command === "getStateManifest")[0];
    assert.deepEqual(Object.keys(manifestCall.message), ["protocolVersion", "requestId", "command"]);
  });

  test("first snapshot with heartbeat sends bootstrap then client manifest in one fetch", async () => {
    const { runtime, provider } = setup();
    await provider.getSnapshot();
    const manifests = runtime.calls.filter((c) => c.message.command === "getStateManifest");
    assert.equal(manifests.length, 2);
    assert.deepEqual(Object.keys(manifests[0].message), ["protocolVersion", "requestId", "command"]);
    assert.deepEqual(manifests[1].message.client, { extensionVersion: "0.1.0", nativeHostVersion: "0.5.0" });
  });

  test("second poll with heartbeat capability sends client params", async () => {
    const { runtime, provider } = setup();
    await provider.getSnapshot();
    await provider.getSnapshot();
    const manifests = runtime.calls.filter((c) => c.message.command === "getStateManifest");
    assert.equal(manifests.length, 3);
    assert.deepEqual(manifests[2].message.client, { extensionVersion: "0.1.0", nativeHostVersion: "0.5.0" });
  });

  test("API v1 without heartbeat capability keeps bootstrap-only manifest requests", async () => {
    const integration = { ...INTEGRATION_V1, capabilities: INTEGRATION_V1.capabilities.filter((c) => c !== "browserClientHeartbeat") };
    const { runtime, provider } = setup({ handler: serving(42, { integration }) });
    await provider.getSnapshot();
    await provider.getSnapshot();
    for (const call of runtime.calls.filter((c) => c.message.command === "getStateManifest")) {
      assert.equal("client" in call.message, false);
    }
  });

  test("session reset after transport error requires bootstrap again", async () => {
    let calls = 0;
    const handler = (host, message) => {
      if (message.command === "getStateManifest") {
        calls++;
        if (calls === 2) return { lastError: "Native host has exited." };
      }
      return serving(42, { integration: INTEGRATION_V1 })(host, message);
    };
    const { runtime, provider } = setup({ handler });
    await provider.getSnapshot();
    await provider.getSnapshot();
    await provider.getSnapshot();
    const manifests = runtime.calls.filter((c) => c.message.command === "getStateManifest");
    assert.equal("client" in manifests[0].message, false);
    assert.deepEqual(manifests[1].message.client, { extensionVersion: "0.1.0", nativeHostVersion: "0.5.0" });
    assert.equal("client" in manifests[2].message, false);
    assert.deepEqual(manifests[3].message.client, { extensionVersion: "0.1.0", nativeHostVersion: "0.5.0" });
  });
});

describe("endpoint PAC reapply", () => {
  test("same revision and endpoint is unchanged", async () => {
    const ctx = setup();
    await ctx.coordinator.sync("startup");
    const sets = ctx.proxy.calls.set.length;
    const view = await ctx.coordinator.sync("popup");
    assert.equal(view.source.lastDecision.kind, Decision.Unchanged);
    assert.equal(ctx.proxy.calls.set.length, sets);
  });

  test("same revision with port change reapplies PAC", async () => {
    const ctx = setup();
    await ctx.coordinator.sync("startup");
    ctx.host.handler = serving(42, {
      integration: INTEGRATION_V1,
      browserProxy: { status: "Ready", endpoint: { host: "127.0.0.1", port: 19001 } }
    });
    const view = await ctx.coordinator.sync("popup");
    assert.equal(view.source.lastDecision.kind, Decision.Applied);
    assert.match(ctx.proxy.ours.pacScript.data, /SOCKS5 127\.0\.0\.1:19001/);
  });

  test("Ready A -> Unavailable -> Ready B ends on port B", async () => {
    const ctx = setup();
    await ctx.coordinator.sync("startup");
    assert.match(ctx.proxy.ours.pacScript.data, /SOCKS5 127\.0\.0\.1:17891/);

    ctx.host.handler = serving(42, { integration: INTEGRATION_V1, browserProxy: UNAVAILABLE });
    await ctx.coordinator.sync("popup");
    assert.match(ctx.proxy.ours.pacScript.data, /SOCKS5 127\.0\.0\.1:17891/);

    ctx.host.handler = serving(42, {
      integration: INTEGRATION_V1,
      browserProxy: { status: "Ready", endpoint: { host: "127.0.0.1", port: 19042 } }
    });
    await ctx.coordinator.sync("popup");
    assert.match(ctx.proxy.ours.pacScript.data, /SOCKS5 127\.0\.0\.1:19042/);
    assert.doesNotMatch(ctx.proxy.ours.pacScript.data, /SOCKS5 127\.0\.0\.1:18001/);
  });

  test("browserClient lastSeen change alone does not reapply PAC", async () => {
    const integration = { ...INTEGRATION_V1, browserClient: { status: "RecentlySeen", lastSeenUtc: "2026-10-05T12:00:00.000Z" } };
    const ctx = setup();
    await ctx.coordinator.sync("startup");
    const sets = ctx.proxy.calls.set.length;
    ctx.host.handler = serving(42, {
      integration: { ...integration, browserClient: { status: "RecentlySeen", lastSeenUtc: "2026-10-05T12:01:00.000Z" } }
    });
    const view = await ctx.coordinator.sync("popup");
    assert.equal(view.source.lastDecision.kind, Decision.Unchanged);
    assert.equal(ctx.proxy.calls.set.length, sets);
  });

  test("vpnEgress Ready transition alone does not reapply PAC", async () => {
    const ctx = setup({ handler: serving(42, { integration: INTEGRATION_V1 }) });
    await ctx.coordinator.sync("startup");
    const sets = ctx.proxy.calls.set.length;
    ctx.host.handler = serving(42, {
      integration: {
        ...INTEGRATION_V1,
        vpnEgress: { status: "Ready", interfaceIndex: 8, interfaceName: "TAP" }
      }
    });
    const view = await ctx.coordinator.sync("popup");
    assert.equal(view.source.lastDecision.kind, Decision.Unchanged);
    assert.equal(ctx.proxy.calls.set.length, sets);
  });
});

describe("fail-closed PAC", () => {
  test("VPN route uses SOCKS5 without DIRECT fallback", async () => {
    const ctx = setup();
    await ctx.coordinator.sync("startup");
    const pac = ctx.proxy.ours.pacScript.data;
    assert.match(pac, /SOCKS5 127\.0\.0\.1:\d+/);
    assert.doesNotMatch(pac, /SOCKS5 127\.0\.0\.1:\d+; DIRECT/);
  });

  test("vpnEgress Unavailable keeps fail-closed SOCKS PAC", async () => {
    const ctx = setup({ handler: serving(42, { integration: INTEGRATION_V1 }) });
    await ctx.coordinator.sync("startup");
    const before = ctx.proxy.ours.pacScript.data;
    ctx.host.handler = serving(42, {
      integration: { ...INTEGRATION_V1, vpnEgress: { status: "Unavailable", interfaceIndex: null, interfaceName: null } }
    });
    await ctx.coordinator.sync("popup");
    assert.equal(ctx.proxy.ours.pacScript.data, before);
    assert.doesNotMatch(ctx.proxy.ours.pacScript.data, /; DIRECT/);
  });
});

describe("PAC fingerprint helper", () => {
  test("endpoint port change changes fingerprint", () => {
    const identity = { stateGeneration: GEN_A, revision: 12 };
    const a = pacApplyFingerprint(identity, { status: "Ready", endpoint: { host: "127.0.0.1", port: 1 } });
    const b = pacApplyFingerprint(identity, { status: "Ready", endpoint: { host: "127.0.0.1", port: 2 } });
    assert.equal(samePacApplyFingerprint(a, b), false);
  });
});

describe("integration compatibility gate", () => {
  test("coordinator surfaces integration_api_incompatible", async () => {
    const integration = { ...INTEGRATION_V1, integrationApiVersion: 99, serviceVersion: "x" };
    const ctx = setup({ handler: serving(42, { integration }) });
    const view = await ctx.coordinator.sync("startup");
    assert.equal(view.source.lastDecision.kind, Decision.IntegrationApiIncompatible);
    assert.match(view.source.lastFetch.errorCode, /integration_api_incompatible/);
  });
});
