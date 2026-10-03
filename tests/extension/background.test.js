import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeProxy } from "./fakes.js";

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
  } finally {
    delete globalThis.chrome;
  }
});
