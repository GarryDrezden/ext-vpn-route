import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { compilePacScript } from "../../src/pac/index.js";
import { createProxyController } from "../../src/extension/runtime/proxy-controller.js";
import {
  Decision,
  Protection,
  StateSource,
  computeProtection,
  createRoutingCoordinator
} from "../../src/extension/runtime/routing-coordinator.js";
import { createNativeStateProvider } from "../../src/extension/state/native-state-provider.js";
import { PHASE3_PROXY_ENDPOINT } from "../../src/extension/runtime/config.js";
import { SMOKE_STATE } from "../../src/extension/state/smoke-state.js";
import {
  createFakeNativeRuntime,
  createFakeProxy,
  createFakeStorage,
  fakeNow,
  nativeHostFailing,
  nativeHostReturning,
  routingState
} from "./fakes.js";

const ENDPOINT = { host: "127.0.0.1", port: 17891 };

function nativeSetup(options = {}) {
  const proxy = options.proxy || createFakeProxy();
  const diagnosticsStorage = options.diagnosticsStorage || createFakeStorage();
  const sourceStorage = options.sourceStorage || createFakeStorage();
  const host = { handler: options.handler || nativeHostReturning(routingState(42)) };
  const runtime = createFakeNativeRuntime((name, message) => host.handler(name, message));
  const compile = options.compile || compilePacScript;
  const makeController = () => createProxyController({ proxy, storage: diagnosticsStorage, compile, now: fakeNow });
  const makeCoordinator = (controller) => createRoutingCoordinator({
    mode: StateSource.Native,
    controller,
    provider: createNativeStateProvider({ runtime, hostName: "com.vpnroute.browser", timeoutMs: 50, now: fakeNow }),
    storage: sourceStorage,
    now: fakeNow
  });
  const ctx = { proxy, host, runtime, diagnosticsStorage, sourceStorage, makeController, makeCoordinator };
  ctx.controller = makeController();
  ctx.coordinator = makeCoordinator(ctx.controller);
  /** Simulates a service worker restart: in-memory state is lost, storage and proxy settings remain. */
  ctx.restart = () => {
    ctx.controller = makeController();
    ctx.coordinator = makeCoordinator(ctx.controller);
  };
  ctx.serve = (handler) => { host.handler = handler; };
  ctx.activeRevision = () => {
    const data = proxy.ours && proxy.ours.pacScript && proxy.ours.pacScript.data;
    const match = data && /revision: (\d+)$/m.exec(data);
    return match ? Number(match[1]) : null;
  };
  return ctx;
}

describe("coordinator: revision policy", () => {
  test("first valid snapshot is applied", async () => {
    const ctx = nativeSetup();
    const view = await ctx.coordinator.sync("installed");

    assert.equal(view.mode, "Native");
    assert.equal(view.diagnostics.status, "APPLIED");
    assert.equal(view.diagnostics.lastApplied.revision, 42);
    assert.equal(view.source.lastDecision.kind, Decision.Applied);
    assert.equal(view.source.lineage.lastAppliedRevision, 42);
    assert.equal(view.source.fetchedRevision, 42);
    assert.equal(view.protection, Protection.Current);
    assert.equal(ctx.activeRevision(), 42);
    assert.equal(ctx.proxy.ours.pacScript.mandatory, true);
  });

  test("42 -> 43 applied; failed fetch for 44 keeps 43; stale 42 is rejected", async () => {
    const ctx = nativeSetup();
    await ctx.coordinator.sync("startup");

    ctx.serve(nativeHostReturning(routingState(43)));
    let view = await ctx.coordinator.sync("popup");
    assert.equal(view.diagnostics.lastApplied.revision, 43);
    assert.equal(ctx.activeRevision(), 43);
    assert.equal(view.protection, Protection.Current);

    ctx.serve(() => ({ lastError: "Native host has exited." }));
    const setsBefore = ctx.proxy.calls.set.length;
    view = await ctx.coordinator.sync("popup");
    assert.equal(view.source.lastDecision.kind, Decision.FetchFailed);
    assert.equal(view.source.lastFetch.result, "ERROR");
    assert.equal(view.source.transport, "ERROR");
    assert.equal(view.source.lastTransportError.code, "host_exited");
    assert.equal(ctx.activeRevision(), 43);
    assert.equal(ctx.proxy.calls.set.length, setsBefore);
    assert.equal(ctx.proxy.calls.clear, 0);
    assert.equal(view.diagnostics.active.pac, "CURRENT");
    assert.equal(view.protection, Protection.LastKnownGood);

    ctx.serve(nativeHostReturning(routingState(42)));
    view = await ctx.coordinator.sync("popup");
    assert.equal(view.source.lastDecision.kind, Decision.StaleSnapshot);
    assert.equal(view.source.fetchedRevision, 42);
    assert.equal(view.source.lineage.lastAppliedRevision, 43);
    assert.equal(ctx.activeRevision(), 43);
    assert.equal(ctx.proxy.calls.set.length, setsBefore);
    assert.equal(view.protection, Protection.LastKnownGood);

    ctx.serve(nativeHostReturning(routingState(44)));
    view = await ctx.coordinator.sync("popup");
    assert.equal(view.source.lastDecision.kind, Decision.Applied);
    assert.equal(ctx.activeRevision(), 44);
    assert.equal(view.protection, Protection.Current);
  });

  test("same revision is idempotent: no second proxy.set", async () => {
    const ctx = nativeSetup();
    await ctx.coordinator.sync("startup");
    const sets = ctx.proxy.calls.set.length;

    const view = await ctx.coordinator.sync("popup");
    assert.equal(view.source.lastDecision.kind, Decision.Unchanged);
    assert.equal(ctx.proxy.calls.set.length, sets);
    assert.equal(view.diagnostics.status, "APPLIED");
    assert.equal(view.protection, Protection.Current);
  });

  test("same revision after a service worker restart is still idempotent", async () => {
    const ctx = nativeSetup();
    await ctx.coordinator.sync("startup");
    const sets = ctx.proxy.calls.set.length;

    ctx.restart();
    const status = await ctx.coordinator.status();
    assert.equal(status.diagnostics.status, "APPLIED");
    assert.equal(status.diagnostics.active.pac, "CURRENT");
    assert.equal(status.diagnostics.active.verification, "header_and_length");
    assert.equal(status.protection, Protection.Current);

    const view = await ctx.coordinator.sync("startup");
    assert.equal(view.source.lastDecision.kind, Decision.Unchanged);
    assert.equal(ctx.proxy.calls.set.length, sets);
  });

  test("stale check survives a service worker restart", async () => {
    const ctx = nativeSetup({ handler: nativeHostReturning(routingState(43)) });
    await ctx.coordinator.sync("startup");
    ctx.restart();
    ctx.serve(nativeHostReturning(routingState(42)));

    const view = await ctx.coordinator.sync("startup");
    assert.equal(view.source.lastDecision.kind, Decision.StaleSnapshot);
    assert.equal(ctx.activeRevision(), 43);
  });

  test("same revision with a changed endpoint is re-applied", async () => {
    const ctx = nativeSetup();
    await ctx.coordinator.sync("startup");
    ctx.serve(nativeHostReturning(routingState(42), { host: "127.0.0.1", port: 18000 }));

    const view = await ctx.coordinator.sync("popup");
    assert.equal(view.source.lastDecision.kind, Decision.Applied);
    assert.match(ctx.proxy.ours.pacScript.data, /SOCKS5 127\.0\.0\.1:18000/);
  });

  test("same revision is re-applied when this PAC is no longer effective", async () => {
    const ctx = nativeSetup();
    await ctx.coordinator.sync("startup");
    ctx.proxy.owner = "none";
    ctx.proxy.ours = null;

    const view = await ctx.coordinator.sync("popup");
    assert.equal(view.source.lastDecision.kind, Decision.Applied);
    assert.equal(ctx.activeRevision(), 42);
  });
});

describe("coordinator: fail-safe", () => {
  const failures = [
    ["host not found", () => ({ lastError: "Specified native messaging host not found." }), "host_not_found"],
    ["timeout", () => ({ hang: true }), "timeout"],
    ["Service unavailable", nativeHostFailing("service_unavailable"), "host_error"],
    ["malformed response", () => ({ response: "garbage" }), "malformed_response"],
    ["request id mismatch", () => ({ response: { protocolVersion: 1, requestId: "x", ok: true, result: {} } }), "request_id_mismatch"],
    ["invalid state", nativeHostReturning({ schemaVersion: 1, revision: -1, defaultRoute: "Direct", rules: [] }), "invalid_state"],
    ["invalid endpoint", nativeHostReturning(routingState(50), { host: "10.0.0.5", port: 1080 }), "invalid_endpoint"]
  ];

  for (const [name, handler, code] of failures) {
    test(name + " keeps the last known good PAC", async () => {
      const ctx = nativeSetup();
      await ctx.coordinator.sync("startup");
      const pac = ctx.proxy.ours.pacScript.data;
      const sets = ctx.proxy.calls.set.length;

      ctx.serve(handler);
      const view = await ctx.coordinator.sync("popup");

      assert.equal(view.source.lastFetch.errorCode, code);
      assert.equal(view.source.lastDecision.kind, Decision.FetchFailed);
      assert.equal(ctx.proxy.ours.pacScript.data, pac);
      assert.equal(ctx.proxy.calls.set.length, sets);
      assert.equal(ctx.proxy.calls.clear, 0);
      assert.equal(view.protection, Protection.LastKnownGood);
    });

    test(name + " without any applied PAC -> NOT_PROTECTED, nothing installed", async () => {
      const ctx = nativeSetup({ handler });
      const view = await ctx.coordinator.sync("startup");

      assert.equal(view.source.lastDecision.kind, Decision.FetchFailed);
      assert.equal(ctx.proxy.calls.set.length, 0);
      assert.equal(ctx.proxy.calls.clear, 0);
      assert.equal(ctx.proxy.owner, "none");
      assert.equal(view.protection, Protection.NotProtected);
    });
  }

  test("Service unavailable is reported as transport AVAILABLE + Service UNAVAILABLE", async () => {
    const ctx = nativeSetup({ handler: nativeHostFailing("service_unavailable") });
    const view = await ctx.coordinator.sync("startup");
    assert.equal(view.source.transport, "AVAILABLE");
    assert.equal(view.source.service, "UNAVAILABLE");
    assert.equal(view.source.lastFetch.hostErrorCode, "service_unavailable");
    assert.equal(view.source.lastTransportError, null);
  });

  test("compile error keeps the previous PAC", async () => {
    let failCompile = false;
    const compile = (state, options) => (failCompile
      ? { ok: false, error: { code: "invalid_state" }, issues: [] }
      : compilePacScript(state, options));
    const ctx = nativeSetup({ compile });
    await ctx.coordinator.sync("startup");
    const pac = ctx.proxy.ours.pacScript.data;

    failCompile = true;
    ctx.serve(nativeHostReturning(routingState(43)));
    const view = await ctx.coordinator.sync("popup");
    assert.equal(view.source.lastDecision.kind, Decision.ApplyFailed);
    assert.equal(view.diagnostics.status, "ERROR");
    assert.equal(view.diagnostics.active.pac, "PREVIOUS");
    assert.equal(ctx.proxy.ours.pacScript.data, pac);
    assert.equal(view.source.lineage.lastAppliedRevision, 42);
    assert.equal(view.protection, Protection.LastKnownGood);
  });

  test("proxy.set failure keeps the previous PAC and the lineage", async () => {
    const ctx = nativeSetup();
    await ctx.coordinator.sync("startup");
    ctx.proxy.failures.set.push("set rejected");
    ctx.serve(nativeHostReturning(routingState(43)));

    const view = await ctx.coordinator.sync("popup");
    assert.equal(view.source.lastDecision.kind, Decision.ApplyFailed);
    assert.equal(ctx.activeRevision(), 42);
    assert.equal(view.source.lineage.lastAppliedRevision, 42);
    assert.equal(view.diagnostics.active.pac, "PREVIOUS");
    assert.equal(view.protection, Protection.LastKnownGood);
  });

  test("a throwing provider is a fetch failure, not a crash", async () => {
    const proxy = createFakeProxy();
    const controller = createProxyController({ proxy, storage: createFakeStorage(), compile: compilePacScript, now: fakeNow });
    const coordinator = createRoutingCoordinator({
      mode: StateSource.Native,
      controller,
      provider: { hostName: "com.vpnroute.browser", protocolVersion: 1, getState: async () => { throw new Error("boom"); } },
      storage: createFakeStorage(),
      now: fakeNow
    });
    const view = await coordinator.sync("startup");
    assert.equal(view.source.lastFetch.errorCode, "provider_exception");
    assert.equal(proxy.calls.set.length, 0);
  });

  test("another extension in control: CONFLICT, nothing overwritten", async () => {
    const ctx = nativeSetup({ proxy: createFakeProxy({ owner: "other" }) });
    const view = await ctx.coordinator.sync("startup");
    assert.equal(view.diagnostics.status, "CONFLICT");
    assert.equal(view.source.lastDecision.kind, Decision.ApplyFailed);
    assert.equal(ctx.proxy.calls.set.length, 0);
    assert.equal(view.protection, Protection.NotProtected);
  });
});

describe("coordinator: clear and fixture isolation", () => {
  test("clear happens only on explicit request and resets the lineage", async () => {
    const ctx = nativeSetup({ handler: nativeHostReturning(routingState(43)) });
    await ctx.coordinator.sync("startup");
    ctx.serve(() => ({ lastError: "Specified native messaging host not found." }));
    await ctx.coordinator.sync("popup");
    await ctx.coordinator.status();
    assert.equal(ctx.proxy.calls.clear, 0);

    const cleared = await ctx.coordinator.clear();
    assert.equal(ctx.proxy.calls.clear, 1);
    assert.equal(cleared.diagnostics.status, "NOT_APPLIED");
    assert.equal(cleared.source.lastDecision.kind, Decision.Cleared);
    assert.equal(cleared.source.lineage.lastAppliedRevision, null);
    assert.equal(cleared.protection, Protection.NotProtected);

    ctx.serve(nativeHostReturning(routingState(5)));
    const view = await ctx.coordinator.sync("popup");
    assert.equal(view.source.lastDecision.kind, Decision.Applied);
    assert.equal(ctx.activeRevision(), 5);
  });

  test("Native mode never falls back to a fixture", async () => {
    const ctx = nativeSetup({ handler: () => ({ lastError: "Specified native messaging host not found." }) });
    for (let i = 0; i < 3; i++) await ctx.coordinator.sync("popup");
    await ctx.coordinator.status();
    assert.equal(ctx.proxy.calls.set.length, 0);
    for (const call of ctx.proxy.calls.set) assert.equal(call.pacScript.data.includes("revision: " + SMOKE_STATE.revision), false);
  });

  test("controller without built-in state refuses apply without a snapshot", async () => {
    const proxy = createFakeProxy();
    const controller = createProxyController({ proxy, storage: createFakeStorage(), compile: compilePacScript, now: fakeNow });
    const diagnostics = await controller.apply("manual");
    assert.equal(diagnostics.status, "ERROR");
    assert.equal(diagnostics.compile.errorCode, "compile_exception");
    assert.equal(proxy.calls.set.length, 0);
  });

  test("source storage holds diagnostics only, never rules or hostnames", async () => {
    const ctx = nativeSetup();
    await ctx.coordinator.sync("startup");
    const text = JSON.stringify(ctx.sourceStorage.value);
    assert.equal(text.includes("youtube"), false);
    assert.equal(text.includes("rules"), false);
    const diagnostics = JSON.stringify(ctx.diagnosticsStorage.value);
    assert.equal(diagnostics.includes("youtube.com"), false);
  });

  test("fixture mode keeps Phase 3 behaviour: every sync recompiles and applies", async () => {
    const proxy = createFakeProxy();
    const storage = createFakeStorage();
    const controller = createProxyController({
      proxy, storage, compile: compilePacScript, loadState: () => SMOKE_STATE, endpoint: PHASE3_PROXY_ENDPOINT, now: fakeNow
    });
    const coordinator = createRoutingCoordinator({ mode: StateSource.Fixture, controller, now: fakeNow });

    let view = await coordinator.sync("installed");
    assert.equal(view.mode, "Fixture");
    assert.equal(view.source, null);
    assert.equal(view.protection, Protection.Current);
    view = await coordinator.sync("popup");
    assert.equal(proxy.calls.set.length, 2);
    assert.equal(view.diagnostics.lastApplied.revision, 3001);
    view = await coordinator.clear();
    assert.equal(view.protection, Protection.NotProtected);
  });

  test("Native mode requires a provider and storage; unknown modes are rejected", () => {
    const controller = { apply() {}, clear() {}, refresh() {}, read() {} };
    assert.throws(() => createRoutingCoordinator({ mode: "Native", controller }), /requires a state provider/);
    assert.throws(() => createRoutingCoordinator({ mode: "Remote", controller }), /Unknown state source mode/);
  });
});

describe("routing protection", () => {
  const applied = (pac, revision, status = "APPLIED") => ({ status, active: { pac, revision } });
  const fetched = (result, revision) => ({ lastFetch: { result }, fetchedRevision: revision });

  test("matrix", () => {
    assert.equal(computeProtection("Native", applied("CURRENT", 43), fetched("OK", 43)), Protection.Current);
    assert.equal(computeProtection("Native", applied("CURRENT", 43), fetched("ERROR", 43)), Protection.LastKnownGood);
    assert.equal(computeProtection("Native", applied("CURRENT", 43), fetched("OK", 42)), Protection.LastKnownGood);
    assert.equal(computeProtection("Native", applied("CURRENT", 43), null), Protection.LastKnownGood);
    assert.equal(computeProtection("Native", applied("PREVIOUS", 43, "ERROR"), fetched("OK", 44)), Protection.LastKnownGood);
    assert.equal(computeProtection("Native", applied("NONE", null, "NOT_APPLIED"), fetched("OK", 1)), Protection.NotProtected);
    assert.equal(computeProtection("Native", applied("UNRECOGNIZED", 9, "ERROR"), fetched("OK", 9)), Protection.NotProtected);
    assert.equal(computeProtection("Native", applied("UNKNOWN", null), fetched("OK", 1)), Protection.NotProtected);
    assert.equal(computeProtection("Fixture", applied("CURRENT", 3001), null), Protection.Current);
    assert.equal(computeProtection("Fixture", applied("PREVIOUS", 3001, "ERROR"), null), Protection.LastKnownGood);
  });
});
