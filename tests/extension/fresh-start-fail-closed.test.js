import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MatchType, RouteMode } from "../../src/domain/browser-routing/constants.js";
import { compilePacScript } from "../../src/pac/index.js";
import { FAIL_CLOSED_BLOCKING_VR_VPN } from "../../src/extension/runtime/config.js";
import {
  Decision,
  createRoutingCoordinator
} from "../../src/extension/runtime/routing-coordinator.js";
import { createNativeStateProvider } from "../../src/extension/state/native-state-provider.js";
import { createProxyController } from "../../src/extension/runtime/proxy-controller.js";
import { loadPac, DIRECT } from "../pac/helpers.js";
import {
  GEN_A,
  INTEGRATION_V1,
  UNAVAILABLE,
  createFakeNativeRuntime,
  createFakeProxy,
  createFakeStorage,
  fakeNow,
  nativeHostServing,
  routingState
} from "./fakes.js";

function vpnState(revision = 42) {
  return routingState(revision, {
    rules: [{
      id: "youtube", name: "YouTube", host: "youtube.com", matchType: MatchType.DomainAndSubdomains,
      routeMode: RouteMode.VPN, enabled: true, source: "User", notes: null
    }]
  });
}

function directOnlyState(revision = 42) {
  return routingState(revision, {
    rules: [{
      id: "ex", name: "Example", host: "example.com", matchType: MatchType.ExactHost,
      routeMode: RouteMode.Direct, enabled: true, source: "User", notes: null
    }]
  });
}

function setup(handler) {
  const proxy = createFakeProxy();
  const runtime = createFakeNativeRuntime(handler);
  const provider = createNativeStateProvider({
    runtime,
    hostName: "com.vpnroute.browser",
    timeoutMs: 500,
    now: fakeNow,
    extensionVersion: "0.1.0"
  });
  const controller = createProxyController({ proxy, storage: createFakeStorage(), compile: compilePacScript, now: fakeNow });
  const coordinator = createRoutingCoordinator({
    mode: "Native",
    controller,
    provider,
    storage: createFakeStorage(),
    now: fakeNow
  });
  return { proxy, runtime, coordinator, provider };
}


describe("fresh-start fail-closed blocking PAC", () => {
  test("A: VPN rule + proxy Unavailable + no LKG → blocking PAC applied", async () => {
    const handler = nativeHostServing(vpnState(), { integration: INTEGRATION_V1, browserProxy: UNAVAILABLE });
    const { proxy, coordinator } = setup(handler);
    const view = await coordinator.sync("startup");
    assert.equal(view.source.lastDecision.kind, Decision.FailClosedBlockingApplied);
    assert.equal(proxy.calls.set.length, 1);
    const pac = proxy.ours.pacScript.data;
    assert.match(pac, /var VR_VPN = "SOCKS5 127\.0\.0\.1:0";/);
    assert.doesNotMatch(pac, /; DIRECT/);
    const vpnRoute = loadPac(pac).find("youtube.com");
    assert.equal(vpnRoute, FAIL_CLOSED_BLOCKING_VR_VPN);
    assert.notEqual(vpnRoute, DIRECT);
  });

  test("B: Direct rule stays DIRECT in blocking state", async () => {
    const handler = nativeHostServing(directOnlyState(), { integration: INTEGRATION_V1, browserProxy: UNAVAILABLE });
    const { coordinator } = setup(handler);
    await coordinator.sync("startup");
    assert.equal((await coordinator.sync("popup")).source.lastDecision.kind, Decision.BrowserProxyUnavailable);
  });

  test("C: blocking PAC VPN branch has no DIRECT fallback", async () => {
    const { proxy, coordinator } = setup(nativeHostServing(vpnState(), { integration: INTEGRATION_V1, browserProxy: UNAVAILABLE }));
    await coordinator.sync("startup");
    assert.doesNotMatch(proxy.ours.pacScript.data, /SOCKS5 127\.0\.0\.1:\d+; DIRECT/);
  });

  test("D: Unavailable bootstrap → Ready port B replaces blocking", async () => {
    const handler = { current: nativeHostServing(vpnState(), { integration: INTEGRATION_V1, browserProxy: UNAVAILABLE }) };
    const ctx = setup((h, m) => handler.current(h, m));
    await ctx.coordinator.sync("startup");
    assert.match(ctx.proxy.ours.pacScript.data, /127\.0\.0\.1:0/);
    handler.current = nativeHostServing(vpnState(), {
      integration: INTEGRATION_V1,
      browserProxy: { status: "Ready", endpoint: { host: "127.0.0.1", port: 19042 } }
    });
    const view = await ctx.coordinator.sync("popup");
    assert.equal(view.source.lastDecision.kind, Decision.Applied);
    assert.match(ctx.proxy.ours.pacScript.data, /SOCKS5 127\.0\.0\.1:19042/);
    assert.doesNotMatch(ctx.proxy.ours.pacScript.data, /127\.0\.0\.1:0/);
  });

  test("E: Ready A → Unavailable keeps LKG port A", async () => {
    let handler = nativeHostServing(vpnState(), {
      integration: INTEGRATION_V1,
      browserProxy: { status: "Ready", endpoint: { host: "127.0.0.1", port: 18080 } }
    });
    const ctx = setup((h, m) => handler(h, m));
    await ctx.coordinator.sync("startup");
    const pacA = ctx.proxy.ours.pacScript.data;
    handler = nativeHostServing(vpnState(), { integration: INTEGRATION_V1, browserProxy: UNAVAILABLE });
    const view = await ctx.coordinator.sync("popup");
    assert.equal(view.source.lastDecision.kind, Decision.BrowserProxyUnavailable);
    assert.equal(ctx.proxy.ours.pacScript.data, pacA);
    assert.match(pacA, /18080/);
  });

  test("F: no VPN routes + Unavailable → no blocking PAC", async () => {
    const state = { schemaVersion: 1, revision: 1, defaultRoute: "Direct", rules: [] };
    const { proxy, coordinator } = setup(nativeHostServing(state, { integration: INTEGRATION_V1, browserProxy: UNAVAILABLE }));
    const view = await coordinator.sync("startup");
    assert.equal(view.source.lastDecision.kind, Decision.BrowserProxyUnavailable);
    assert.equal(proxy.calls.set.length, 0);
  });
});

describe("native host version from ping", () => {
  test("G/H: heartbeat uses ping hostVersion not default constant", async () => {
    const runtime = createFakeNativeRuntime(nativeHostServing(vpnState(), {
      integration: INTEGRATION_V1,
      hostVersion: "2.3.4"
    }));
    const provider = createNativeStateProvider({
      runtime,
      hostName: "com.vpnroute.browser",
      timeoutMs: 500,
      now: fakeNow
    });
    await provider.getSnapshot();
    await provider.getSnapshot();
    const ping = runtime.calls.find((c) => c.message.command === "ping");
    assert.ok(ping);
    const manifests = runtime.calls.filter((c) => c.message.command === "getStateManifest");
    assert.deepEqual(manifests[1].message.client.nativeHostVersion, "2.3.4");
    assert.notEqual(manifests[1].message.client.nativeHostVersion, "0.0.0");
  });

  test("I: session reset re-pings and uses new hostVersion", async () => {
    let version = "1.0.0";
    const runtime = createFakeNativeRuntime((host, message) => {
      if (message.command === "ping") {
        return {
          response: {
            protocolVersion: 1,
            requestId: message.requestId,
            ok: true,
            result: { command: "pong", host: "SelectiveVpnRouter.NativeHost", protocolVersion: 1, hostVersion: version }
          }
        };
      }
      return nativeHostServing(vpnState(), { integration: INTEGRATION_V1 })(host, message);
    });
    const provider = createNativeStateProvider({ runtime, hostName: "com.vpnroute.browser", timeoutMs: 500, now: fakeNow });
    await provider.getSnapshot();
    version = "1.0.1";
    provider.resetIntegrationSession();
    await provider.getSnapshot();
    await provider.getSnapshot();
    const heartbeats = runtime.calls.filter((c) => c.message.command === "getStateManifest" && c.message.client);
    assert.equal(heartbeats[heartbeats.length - 1].message.client.nativeHostVersion, "1.0.1");
  });

  test("J: dependency override pins version and skips ping", async () => {
    const runtime = createFakeNativeRuntime(nativeHostServing(vpnState(), { integration: INTEGRATION_V1, hostVersion: "2.0.0" }));
    const provider = createNativeStateProvider({
      runtime,
      hostName: "com.vpnroute.browser",
      nativeHostVersion: "9.9.9-test",
      timeoutMs: 500,
      now: fakeNow
    });
    await provider.getSnapshot();
    await provider.getSnapshot();
    assert.equal(runtime.calls.some((c) => c.message.command === "ping"), false);
    const heartbeat = runtime.calls.find((c) => c.message.command === "getStateManifest" && c.message.client);
    assert.equal(heartbeat.message.client.nativeHostVersion, "9.9.9-test");
  });
});
