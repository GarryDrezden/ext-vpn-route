import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { compilePacScript } from "../../src/pac/index.js";
import { PHASE3_PROXY_ENDPOINT } from "../../src/extension/runtime/config.js";
import { createProxyController, readHeaderRevision } from "../../src/extension/runtime/proxy-controller.js";
import { SMOKE_STATE } from "../../src/extension/state/smoke-state.js";
import { loadPac } from "../pac/helpers.js";
import { createFakeProxy, createFakeStorage, fakeNow } from "./fakes.js";

const VPN = "SOCKS5 127.0.0.1:17891";

function setup(proxyOptions, { state = SMOKE_STATE, storage } = {}) {
  const proxy = createFakeProxy(proxyOptions);
  const store = storage || createFakeStorage();
  const current = { state };
  const controller = createProxyController({
    proxy,
    storage: store,
    loadState: () => current.state,
    compile: compilePacScript,
    endpoint: PHASE3_PROXY_ENDPOINT,
    now: fakeNow
  });
  return { proxy, store, controller, current };
}

const expectedScript = compilePacScript(SMOKE_STATE, PHASE3_PROXY_ENDPOINT).script;

function invalidState() {
  return { ...SMOKE_STATE, revision: 3002, rules: [...SMOKE_STATE.rules, { ...SMOKE_STATE.rules[0], id: "dup-host" }] };
}

function routeOf(proxy, host) {
  return loadPac(proxy.ours.pacScript.data).find(host);
}

describe("apply: levelOfControl", () => {
  test("controllable_by_this_extension applies a mandatory inline PAC", async () => {
    const { proxy, controller } = setup();
    const d = await controller.apply("installed");
    assert.equal(proxy.calls.set.length, 1);
    assert.deepEqual(proxy.calls.set[0], { mode: "pac_script", pacScript: { data: expectedScript, mandatory: true } });
    assert.equal(d.status, "APPLIED");
    assert.equal(d.levelOfControl, "controlled_by_this_extension");
    assert.deepEqual(
      [d.state.revision, d.compile.revision, d.active.revision, d.lastApplied.revision],
      [3001, 3001, 3001, 3001]);
    assert.equal(d.active.pac, "CURRENT");
    assert.equal(d.active.verification, "data_match");
    assert.equal(d.active.mode, "pac_script");
    assert.equal(d.active.mandatory, true);
    assert.equal(d.compile.endpoint, "127.0.0.1:17891");
    assert.equal(d.lastError, null);
    assert.equal(d.lastOperation.kind, "apply:installed");
  });

  test("controlled_by_this_extension updates the PAC", async () => {
    const { proxy, controller, current } = setup();
    await controller.apply("installed");
    current.state = { ...SMOKE_STATE, revision: 3002 };
    const d = await controller.apply("popup");
    assert.equal(proxy.calls.set.length, 2);
    assert.equal(d.status, "APPLIED");
    assert.equal(d.active.revision, 3002);
    assert.equal(readHeaderRevision(proxy.ours.pacScript.data), 3002);
  });

  test("controlled_by_other_extensions is never overwritten", async () => {
    const { proxy, controller } = setup({ owner: "other" });
    const d = await controller.apply("startup");
    assert.equal(proxy.calls.set.length, 0);
    assert.equal(proxy.calls.clear, 0);
    assert.equal(d.status, "CONFLICT");
    assert.match(d.lastError.message, /Another extension/);
    assert.equal(d.active.pac, "NONE");
  });

  test("not_controllable is never overwritten", async () => {
    const { proxy, controller } = setup({ owner: "policy" });
    const d = await controller.apply("startup");
    assert.equal(proxy.calls.set.length, 0);
    assert.equal(d.status, "NOT_CONTROLLABLE");
    assert.match(d.lastError.message, /policy/);
  });

  test("proxy API unavailable makes no calls", async () => {
    const { proxy, controller } = setup({ available: false });
    const d = await controller.apply("installed");
    assert.equal(d.status, "UNAVAILABLE");
    assert.equal(d.proxyApi, "UNAVAILABLE");
    assert.equal(proxy.calls.get + proxy.calls.set.length + proxy.calls.clear, 0);
  });

  test("a failed initial get() does not call set()", async () => {
    const { proxy, controller } = setup();
    proxy.failures.get.push("boom");
    const d = await controller.apply("installed");
    assert.equal(d.status, "ERROR");
    assert.equal(proxy.calls.set.length, 0);
  });
});

describe("apply: compile failures never fall back to DIRECT", () => {
  test("no existing PAC: ERROR, no set, no clear, not protected", async () => {
    const { proxy, controller } = setup({}, { state: invalidState() });
    const d = await controller.apply("startup");
    assert.equal(d.status, "ERROR");
    assert.equal(d.compile.status, "ERROR");
    assert.equal(d.compile.errorCode, "invalid_state");
    assert.equal(proxy.calls.set.length, 0);
    assert.equal(proxy.calls.clear, 0);
    assert.equal(d.active.pac, "NONE");
    assert.match(d.lastError.message, /NOT protected/);
  });

  test("existing PAC stays active as last known good", async () => {
    const { proxy, controller, current } = setup();
    await controller.apply("installed");
    current.state = invalidState();
    const d = await controller.apply("popup");
    assert.equal(d.status, "ERROR");
    assert.equal(proxy.calls.set.length, 1);
    assert.equal(proxy.calls.clear, 0);
    assert.equal(proxy.ours.pacScript.data, expectedScript);
    assert.equal(d.active.pac, "PREVIOUS");
    assert.equal(d.active.revision, 3001);
    assert.equal(d.lastApplied.revision, 3001);
    assert.match(d.lastError.message, /Last known good PAC revision 3001 stays active/);
    assert.equal(routeOf(proxy, "www.youtube.com"), VPN);
  });

  test("a throwing state provider is a compile failure, not a crash", async () => {
    const { proxy, controller, current } = setup();
    await controller.apply("installed");
    current.state = undefined;
    const d = await controller.apply("popup");
    assert.equal(d.status, "ERROR");
    assert.equal(proxy.calls.set.length, 1);
    assert.equal(d.active.pac, "PREVIOUS");
  });
});

describe("apply: set and read-back", () => {
  test("set() failure is ERROR and keeps the previous PAC", async () => {
    const { proxy, controller, current } = setup();
    await controller.apply("installed");
    current.state = { ...SMOKE_STATE, revision: 3002 };
    proxy.failures.set.push("Proxy settings write failed");
    const d = await controller.apply("popup");
    assert.equal(d.status, "ERROR");
    assert.match(d.lastError.message, /proxy\.settings\.set failed: Proxy settings write failed/);
    assert.equal(d.active.pac, "PREVIOUS");
    assert.equal(d.active.revision, 3001);
    assert.equal(d.lastApplied.revision, 3001);
    assert.equal(proxy.calls.clear, 0);
  });

  test("read-back with different PAC data is ERROR", async () => {
    const { proxy, controller } = setup();
    proxy.transformRead = (value) => ({ ...value, pacScript: { ...value.pacScript, data: value.pacScript.data.replace("17891", "17892") } });
    const d = await controller.apply("installed");
    assert.equal(d.status, "ERROR");
    assert.match(d.lastError.message, /Read-back does not show this PAC \(PAC data differs\)/);
    assert.equal(d.lastApplied, null);
  });

  test("read-back without mandatory is ERROR", async () => {
    const { proxy, controller } = setup();
    proxy.transformRead = (value) => ({ ...value, pacScript: { ...value.pacScript, mandatory: false } });
    const d = await controller.apply("installed");
    assert.equal(d.status, "ERROR");
    assert.match(d.lastError.message, /mandatory/);
  });

  test("set() that silently does nothing is ERROR, not APPLIED", async () => {
    const { proxy, controller } = setup();
    proxy.ignoreSet = true;
    const d = await controller.apply("installed");
    assert.equal(proxy.calls.set.length, 1);
    assert.equal(d.status, "ERROR");
    assert.equal(d.active.pac, "NONE");
  });

  test("read-back get() failure is ERROR", async () => {
    const { proxy, controller } = setup();
    proxy.failures.get.push(undefined, "read-back boom");
    const d = await controller.apply("installed");
    assert.equal(d.status, "ERROR");
    assert.match(d.lastError.message, /read-back failed: read-back boom/);
  });

  test("CRLF or trailing whitespace from the browser still matches", async () => {
    const { proxy, controller } = setup();
    proxy.transformRead = (value) => ({ ...value, pacScript: { ...value.pacScript, data: value.pacScript.data.replace(/\n/g, "\r\n") + "\r\n" } });
    const d = await controller.apply("installed");
    assert.equal(d.status, "APPLIED");
    assert.equal(d.active.verification, "data_match");
  });

  test("browser that does not return PAC data: APPLIED from mode, mandatory and level", async () => {
    const { controller } = setup({ returnsData: false });
    const d = await controller.apply("installed");
    assert.equal(d.status, "APPLIED");
    assert.equal(d.active.verification, "data_unavailable");
    assert.equal(d.active.dataReturned, false);
    assert.equal(d.active.revision, 3001);
  });

  test("APPLYING is persisted before set()", async () => {
    const { proxy, store, controller } = setup();
    const seen = [];
    const originalSet = proxy.set;
    proxy.set = async (value) => {
      seen.push(store.value.status);
      return originalSet(value);
    };
    await controller.apply("installed");
    assert.deepEqual(seen, ["APPLYING"]);
  });

  test("reapply is idempotent and always re-verifies", async () => {
    const { proxy, controller } = setup();
    for (let i = 0; i < 3; i++) {
      const d = await controller.apply("popup");
      assert.equal(d.status, "APPLIED");
    }
    assert.equal(proxy.calls.set.length, 3);
    assert.ok(proxy.calls.get >= 6);
  });
});

describe("clear and refresh", () => {
  test("clear() only on explicit command; refresh never applies or clears", async () => {
    const { proxy, controller } = setup();
    await controller.apply("installed");
    await controller.refresh();
    await controller.recordProxyError({ fatal: false, error: "net::ERR_PROXY_CONNECTION_FAILED", details: "" });
    assert.equal(proxy.calls.clear, 0);
    assert.equal(proxy.calls.set.length, 1);

    const d = await controller.clear();
    assert.equal(proxy.calls.clear, 1);
    assert.equal(d.status, "NOT_APPLIED");
    assert.equal(d.active.pac, "NONE");
    assert.equal(d.active.revision, null);
    assert.equal(d.lastApplied, null);
    assert.equal(d.levelOfControl, "controllable_by_this_extension");

    const after = await controller.refresh();
    assert.equal(after.status, "NOT_APPLIED");
    assert.equal(proxy.calls.set.length, 1);

    const reapplied = await controller.apply("popup");
    assert.equal(reapplied.status, "APPLIED");
  });

  test("clear() that leaves the PAC effective is ERROR", async () => {
    const { proxy, controller } = setup();
    await controller.apply("installed");
    proxy.clear = async () => { proxy.calls.clear++; };
    const d = await controller.clear();
    assert.equal(d.status, "ERROR");
    assert.match(d.lastError.message, /still effective/);
  });

  test("a new service worker instance recovers APPLIED from read-back", async () => {
    const first = setup();
    await first.controller.apply("installed");
    const second = createProxyController({
      proxy: first.proxy, storage: first.store, loadState: () => SMOKE_STATE,
      compile: compilePacScript, endpoint: PHASE3_PROXY_ENDPOINT, now: fakeNow
    });
    const d = await second.refresh();
    assert.equal(d.status, "APPLIED");
    assert.equal(d.active.revision, 3001);
    assert.equal(first.proxy.calls.set.length, 1);
  });

  test("refresh reports a takeover by another extension", async () => {
    const { proxy, controller } = setup();
    await controller.apply("installed");
    proxy.owner = "other";
    const d = await controller.refresh();
    assert.equal(d.status, "CONFLICT");
    assert.equal(d.active.pac, "NONE");
  });

  test("refresh keeps ERROR visible while the last known good PAC is active", async () => {
    const { controller, current } = setup();
    await controller.apply("installed");
    current.state = invalidState();
    await controller.apply("popup");
    const d = await controller.refresh();
    assert.equal(d.status, "ERROR");
    assert.equal(d.active.pac, "PREVIOUS");
    assert.equal(d.active.revision, 3001);
  });

  test("refresh does not turn a failed apply into NOT_APPLIED", async () => {
    const { proxy, controller } = setup();
    proxy.ignoreSet = true;
    await controller.apply("installed");
    const d = await controller.refresh();
    assert.equal(d.status, "ERROR");
    assert.equal(d.active.pac, "NONE");
    assert.ok(d.lastError);
  });

  test("refresh on a fresh profile is IDLE and does not apply", async () => {
    const { proxy, controller } = setup();
    const d = await controller.refresh();
    assert.equal(d.status, "IDLE");
    assert.equal(proxy.calls.set.length, 0);
    assert.equal(d.compile.status, "COMPILED");
    assert.equal(d.state.revision, 3001);
  });
});

describe("proxy errors and stored diagnostics", () => {
  test("onProxyError is recorded without changing routing status", async () => {
    const { controller } = setup();
    await controller.apply("installed");
    const d = await controller.recordProxyError({ fatal: true, error: "net::ERR_PAC_SCRIPT_FAILED", details: "x".repeat(1000) });
    assert.equal(d.status, "APPLIED");
    assert.equal(d.lastProxyError.fatal, true);
    assert.equal(d.lastProxyError.error, "net::ERR_PAC_SCRIPT_FAILED");
    assert.ok(d.lastProxyError.details.length <= 303);
  });

  test("storage holds diagnostics only, never rules, hosts or the PAC", async () => {
    const { store, controller } = setup();
    await controller.apply("installed");
    await controller.recordProxyError({ fatal: false, error: "e", details: "" });
    const text = JSON.stringify(store.value);
    for (const forbidden of ["youtube.com", "googlevideo.com", "example.com", "FindProxyForURL", "\"rules\""]) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
    assert.ok(text.length < 4000);
  });

  test("operations are serialized", async () => {
    const { proxy, controller } = setup();
    const results = await Promise.all([controller.apply("installed"), controller.clear(), controller.apply("popup")]);
    assert.deepEqual(results.map((d) => d.status), ["APPLIED", "NOT_APPLIED", "APPLIED"]);
    assert.equal(proxy.calls.set.length, 2);
    assert.equal(proxy.calls.clear, 1);
  });

  test("diagnostics from an unknown version are discarded", async () => {
    const { controller } = setup({}, { storage: createFakeStorage({ diagnosticsVersion: 99, status: "APPLIED", lastApplied: { revision: 1 } }) });
    const d = await controller.refresh();
    assert.equal(d.status, "IDLE");
    assert.equal(d.lastApplied, null);
  });
});
