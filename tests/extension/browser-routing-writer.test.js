import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseIntegrationManifest } from "../../src/extension/state/integration-manifest.js";
import {
  BROWSER_ROUTING_WRITE_CAPABILITY,
  ServiceWriteErrorCode,
  WriterErrorCode,
  createBrowserRoutingWriter,
  syncAfterBrowserRoutingWrite
} from "../../src/extension/state/browser-routing-writer.js";
import { createRoutingCoordinator, StateSource } from "../../src/extension/runtime/routing-coordinator.js";
import { createProxyController } from "../../src/extension/runtime/proxy-controller.js";
import { compilePacScript } from "../../src/pac/index.js";
import { createNativeStateProvider } from "../../src/extension/state/native-state-provider.js";
import {
  GEN_A,
  INTEGRATION_V1,
  READY,
  createFakeNativeRuntime,
  createFakeProxy,
  createFakeStorage,
  fakeNow,
  hostOk,
  nativeHostServing,
  routingState
} from "./fakes.js";

const SAMPLE_RULE = Object.freeze({
  id: "new-rule",
  name: "New",
  host: "new.example",
  matchType: "ExactHost",
  routeMode: "VPN",
  enabled: true,
  source: "User",
  notes: null
});

function baseManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    stateGeneration: GEN_A,
    revision: 0,
    defaultRoute: "Direct",
    ruleCount: 0,
    pageBudgetBytes: 520192,
    browserProxy: READY,
    ...INTEGRATION_V1,
    ...overrides
  };
}

function integrationWithWrite(extra = {}) {
  const parsed = parseIntegrationManifest(baseManifest(extra));
  assert.equal(parsed.ok, true);
  return parsed.integration;
}

function integrationWithoutWrite() {
  const parsed = parseIntegrationManifest(baseManifest({
    capabilities: INTEGRATION_V1.capabilities.filter((c) => c !== BROWSER_ROUTING_WRITE_CAPABILITY)
  }));
  assert.equal(parsed.ok, true);
  return parsed.integration;
}

function writeResult(revision, ruleCount = 1) {
  return {
    stateGeneration: GEN_A,
    revision,
    defaultRoute: "Direct",
    ruleCount
  };
}

describe("browser routing writer", () => {
  test("capability absent returns unsupported_capability", async () => {
    const runtime = createFakeNativeRuntime(() => ({}));
    const writer = createBrowserRoutingWriter({ runtime, hostName: "com.vpnroute.browser", timeoutMs: 200 });
    const outcome = await writer.upsertRule({
      integration: integrationWithoutWrite(),
      expectedRevision: 1,
      rule: SAMPLE_RULE
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, WriterErrorCode.UnsupportedCapability);
    assert.equal(runtime.calls.length, 0);
  });

  test("upsert success returns authoritative write result", async () => {
    const runtime = createFakeNativeRuntime((_, message) => {
      if (message.command === "upsertRule") {
        return hostOk(message, writeResult(11));
      }
      return hostError(message, "unknown_command");
    });
    const writer = createBrowserRoutingWriter({ runtime, hostName: "com.vpnroute.browser", timeoutMs: 500 });
    const outcome = await writer.upsertRule({
      integration: integrationWithWrite(),
      expectedRevision: 10,
      rule: SAMPLE_RULE
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.result, writeResult(11));
    assert.equal(runtime.calls[0].message.expectedRevision, 10);
    assert.deepEqual(runtime.calls[0].message.rule, SAMPLE_RULE);
  });

  test("revision_conflict preserves currentRevision", async () => {
    const runtime = createFakeNativeRuntime((_, message) => hostError(message, ServiceWriteErrorCode.RevisionConflict, "conflict", {
      currentRevision: 12
    }));
    const writer = createBrowserRoutingWriter({ runtime, hostName: "com.vpnroute.browser", timeoutMs: 500 });
    const outcome = await writer.upsertRule({
      integration: integrationWithWrite(),
      expectedRevision: 10,
      rule: SAMPLE_RULE
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, ServiceWriteErrorCode.RevisionConflict);
    assert.equal(outcome.error.currentRevision, 12);
  });

  test("validation_failed is surfaced without host_error wrapper", async () => {
    const runtime = createFakeNativeRuntime((_, message) =>
      hostError(message, ServiceWriteErrorCode.ValidationFailed, "invalid"));
    const writer = createBrowserRoutingWriter({ runtime, hostName: "com.vpnroute.browser", timeoutMs: 500 });
    const outcome = await writer.deleteRule({ integration: integrationWithWrite(), expectedRevision: 1, id: "x" });
    assert.equal(outcome.error.code, ServiceWriteErrorCode.ValidationFailed);
  });

  test("service unavailable maps to host_error with hostErrorCode", async () => {
    const runtime = createFakeNativeRuntime((_, message) => hostError(message, "service_unavailable", "down"));
    const writer = createBrowserRoutingWriter({ runtime, hostName: "com.vpnroute.browser", timeoutMs: 500 });
    const outcome = await writer.resetRules({ integration: integrationWithWrite(), expectedRevision: 0 });
    assert.equal(outcome.error.code, WriterErrorCode.HostError);
    assert.equal(outcome.error.hostErrorCode, "service_unavailable");
  });

  test("native messaging failure is transport_unavailable", async () => {
    const runtime = createFakeNativeRuntime(() => ({ lastError: "Native host not found." }));
    const writer = createBrowserRoutingWriter({ runtime, hostName: "com.vpnroute.browser", timeoutMs: 500 });
    const outcome = await writer.resetRules({ integration: integrationWithWrite(), expectedRevision: 0 });
    assert.equal(outcome.error.code, WriterErrorCode.TransportUnavailable);
  });

  test("does not auto-retry conflict", async () => {
    let calls = 0;
    const runtime = createFakeNativeRuntime((_, message) => {
      calls++;
      return hostError(message, ServiceWriteErrorCode.RevisionConflict, "conflict", { currentRevision: 2 });
    });
    const writer = createBrowserRoutingWriter({ runtime, hostName: "com.vpnroute.browser", timeoutMs: 500 });
    await writer.upsertRule({ integration: integrationWithWrite(), expectedRevision: 1, rule: SAMPLE_RULE });
    assert.equal(calls, 1);
  });
});

function hostError(message, code, text, extra = {}) {
  return {
    response: {
      protocolVersion: 1,
      requestId: message.requestId,
      ok: false,
      error: { code, message: text, ...extra }
    }
  };
}

describe("browser routing write + coordinator sync", () => {
  function setup(initialRevision, options = {}) {
    const state = routingState(initialRevision, options.stateOverrides || {});
    const proxy = createFakeProxy();
    const storage = createFakeStorage();
    let live = cloneState(state);
    const handler = (hostName, message) => {
      if (message.command === "upsertRule") {
        live.revision += 1;
        live.rules = live.rules.filter((r) => r.id !== message.rule.id).concat([message.rule]);
        return hostOk(message, writeResult(live.revision, live.rules.length));
      }
      return nativeHostServing(live, { integration: INTEGRATION_V1, browserProxy: READY })(hostName, message);
    };
    const runtime = createFakeNativeRuntime(handler);
    const provider = createNativeStateProvider({ runtime, hostName: "com.vpnroute.browser", timeoutMs: 500, now: fakeNow });
    const writer = createBrowserRoutingWriter({ runtime, hostName: "com.vpnroute.browser", timeoutMs: 500, now: fakeNow });
    const coordinator = createRoutingCoordinator({
      mode: StateSource.Native,
      controller: createProxyController({ proxy, storage, compile: compilePacScript, now: fakeNow }),
      provider,
      storage,
      now: fakeNow
    });
    const integration = integrationWithWrite();
    return { proxy, writer, coordinator, integration, live, runtime };
  }

  test("successful upsert then sync reapplies PAC for new revision", async () => {
    const ctx = setup(5);
    const before = await ctx.coordinator.sync("installed");
    const pacBefore = ctx.proxy.ours.pacScript.data;
    const write = await ctx.writer.upsertRule({
      integration: ctx.integration,
      expectedRevision: 5,
      rule: { ...SAMPLE_RULE, id: "extra" }
    });
    assert.equal(write.ok, true);
    assert.equal(write.result.revision, 6);
    const combined = await syncAfterBrowserRoutingWrite(ctx.coordinator, write, "post-write");
    assert.equal(combined.sync.diagnostics.lastApplied.revision, 6);
    assert.notEqual(ctx.proxy.ours.pacScript.data, pacBefore);
    assert.match(ctx.proxy.ours.pacScript.data, /revision: 6/);
  });

  test("failed write leaves PAC unchanged", async () => {
    const ctx = setup(3);
    await ctx.coordinator.sync("installed");
    const pacBefore = ctx.proxy.ours.pacScript.data;
    ctx.runtime.sendNativeMessage = (hostName, message, callback) => {
      callback({
        protocolVersion: 1,
        requestId: message.requestId,
        ok: false,
        error: { code: ServiceWriteErrorCode.ValidationFailed, message: "bad rule" }
      });
    };
    const write = await ctx.writer.upsertRule({
      integration: ctx.integration,
      expectedRevision: 3,
      rule: SAMPLE_RULE
    });
    assert.equal(write.ok, false);
    await ctx.coordinator.sync("manual");
    assert.equal(ctx.proxy.ours.pacScript.data, pacBefore);
  });
});

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}
