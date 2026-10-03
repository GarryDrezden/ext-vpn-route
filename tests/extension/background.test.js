import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DIST_ROOT, buildExtension } from "../../scripts/build-extension.js";
import { createFakeNativeRuntime, createFakeProxy, nativeHostFailing, nativeHostReturning, routingState } from "./fakes.js";

const EXTENSION_ID = "lfaekfalhkgmbfdjjlfcalanhijeaien";

function event() {
  const listeners = [];
  return { listeners, addListener: (listener) => listeners.push(listener) };
}

function createChromeMock() {
  const proxy = createFakeProxy();
  const storage = {};
  const chrome = {
    runtime: { id: EXTENSION_ID, lastError: undefined, onInstalled: event(), onStartup: event(), onMessage: event() },
    proxy: { onProxyError: event(), settings: {} },
    storage: { local: {} }
  };

  function callback(promise, done) {
    promise.then(
      (value) => setImmediate(() => done(value)),
      (error) => setImmediate(() => {
        chrome.runtime.lastError = { message: error.message };
        try { done(undefined); } finally { chrome.runtime.lastError = undefined; }
      }));
  }

  chrome.proxy.settings.get = (details, done) => {
    assert.deepEqual(details, { incognito: false });
    callback(proxy.get(), done);
  };
  chrome.proxy.settings.set = (details, done) => {
    assert.equal(details.scope, "regular");
    callback(proxy.set(details.value), done);
  };
  chrome.proxy.settings.clear = (details, done) => {
    assert.deepEqual(details, { scope: "regular" });
    callback(proxy.clear(), done);
  };
  chrome.storage.local.get = (key, done) => callback(Promise.resolve({ [key]: storage[key] && JSON.parse(storage[key]) }), done);
  chrome.storage.local.set = (items, done) => {
    for (const [key, value] of Object.entries(items)) storage[key] = JSON.stringify(value);
    callback(Promise.resolve(), done);
  };
  return { chrome, proxy, storage };
}

function send(chrome, message, sender = { id: EXTENSION_ID }) {
  return new Promise((resolve) => {
    let responded = false;
    const keepOpen = chrome.runtime.onMessage.listeners[0](message, sender, (response) => {
      responded = true;
      resolve(response);
    });
    if (keepOpen !== true) setImmediate(() => resolve(responded ? undefined : "no-response"));
  });
}

test("service worker wires lifecycle events, commands and chrome.runtime.lastError", async () => {
  const mock = createChromeMock();
  globalThis.chrome = mock.chrome;
  try {
    await import("../../src/extension/background.js");
    const { runtime, proxy } = mock.chrome;
    assert.equal(runtime.onInstalled.listeners.length, 1);
    assert.equal(runtime.onStartup.listeners.length, 1);
    assert.equal(runtime.onMessage.listeners.length, 1);
    assert.equal(proxy.onProxyError.listeners.length, 1);
    assert.equal(mock.proxy.calls.set.length, 0, "loading the worker must not apply anything");

    runtime.onInstalled.listeners[0]({ reason: "install" });
    let status = await send(mock.chrome, { command: "status" });
    assert.equal(status.ok, true);
    assert.equal(status.fixture, "normal");
    assert.equal(status.diagnostics.status, "APPLIED");
    assert.equal(status.diagnostics.active.revision, 3001);
    assert.equal(mock.proxy.calls.set.length, 1);
    assert.equal(mock.proxy.calls.set[0].pacScript.mandatory, true);

    assert.equal(await send(mock.chrome, { command: "clear" }, { id: "other-extension" }), "no-response");
    assert.equal(await send(mock.chrome, { command: "clear" }, { id: EXTENSION_ID, tab: { id: 1 } }), "no-response");
    assert.equal(await send(mock.chrome, { command: "eval" }), "no-response");
    assert.equal(await send(mock.chrome, { command: "__proto__" }), "no-response");
    assert.equal(await send(mock.chrome, null), "no-response");
    assert.equal(mock.proxy.calls.clear, 0);

    const cleared = await send(mock.chrome, { command: "clear" });
    assert.equal(cleared.diagnostics.status, "NOT_APPLIED");
    assert.equal(mock.proxy.calls.clear, 1);

    mock.proxy.failures.set.push("Simulated lastError");
    const failed = await send(mock.chrome, { command: "reapply" });
    assert.equal(failed.diagnostics.status, "ERROR");
    assert.match(failed.diagnostics.lastError.message, /Simulated lastError/);

    const reapplied = await send(mock.chrome, { command: "reapply" });
    assert.equal(reapplied.diagnostics.status, "APPLIED");

    proxy.onProxyError.listeners[0]({ fatal: false, error: "net::ERR_PROXY_CONNECTION_FAILED", details: "" });
    runtime.onStartup.listeners[0]();
    status = await send(mock.chrome, { command: "status" });
    assert.equal(status.diagnostics.lastProxyError.error, "net::ERR_PROXY_CONNECTION_FAILED");
    assert.equal(status.diagnostics.status, "APPLIED");
    assert.equal(mock.proxy.calls.set.length, 4);

    const stored = Object.keys(mock.storage);
    assert.deepEqual(stored, ["vpnRouteDiagnostics"]);
    assert.equal(status.mode, "Fixture");
    assert.equal(status.protection, "CURRENT");
  } finally {
    delete globalThis.chrome;
  }
});

test("native build service worker fetches state over native messaging and keeps last-known-good", async () => {
  const outDir = path.join(DIST_ROOT, ".test-bg-" + process.pid, "extension");
  await buildExtension({ mode: "native", outDir });
  const mock = createChromeMock();
  const host = { handler: nativeHostReturning(routingState(42)) };
  const native = createFakeNativeRuntime((name, message) => host.handler(name, message));
  mock.chrome.runtime.sendNativeMessage = (name, message, callback) =>
    native.sendNativeMessage(name, message, (response) => {
      mock.chrome.runtime.lastError = native.lastError;
      try { callback(response); } finally { mock.chrome.runtime.lastError = undefined; }
    });
  globalThis.chrome = mock.chrome;
  try {
    await import(pathToFileURL(path.join(outDir, "extension/background.js")).href);
    const { runtime } = mock.chrome;
    assert.equal(native.calls.length, 0, "loading the worker must not contact the host");

    runtime.onInstalled.listeners[0]({ reason: "install" });
    let status = await send(mock.chrome, { command: "status" });
    assert.equal(status.mode, "Native");
    assert.equal(status.fixture, null);
    assert.equal(status.diagnostics.status, "APPLIED");
    assert.equal(status.diagnostics.lastApplied.revision, 42);
    assert.equal(status.source.hostName, "com.vpnroute.browser");
    assert.equal(status.protection, "CURRENT");
    assert.equal(native.calls[0].hostName, "com.vpnroute.browser");

    host.handler = nativeHostFailing("service_unavailable", "VPN Route Service is unavailable.");
    const refreshed = await send(mock.chrome, { command: "reapply" });
    assert.equal(refreshed.source.service, "UNAVAILABLE");
    assert.equal(refreshed.source.lastDecision.kind, "fetch_failed");
    assert.equal(refreshed.diagnostics.active.revision, 42);
    assert.equal(refreshed.protection, "LAST_KNOWN_GOOD");
    assert.equal(mock.proxy.calls.set.length, 1);
    assert.equal(mock.proxy.calls.clear, 0);

    runtime.onStartup.listeners[0]();
    status = await send(mock.chrome, { command: "status" });
    assert.equal(native.calls.length, 3);
    assert.equal(mock.proxy.calls.set.length, 1);

    assert.deepEqual(Object.keys(mock.storage).sort(), ["vpnRouteDiagnostics", "vpnRouteStateSource"]);
    assert.equal(JSON.stringify(mock.storage).includes("youtube.com"), false);
  } finally {
    delete globalThis.chrome;
    rmSync(path.dirname(outDir), { recursive: true, force: true });
  }
});
