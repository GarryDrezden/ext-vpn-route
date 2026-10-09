import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DIST_ROOT, ROOT, buildExtension } from "../../scripts/build-extension.js";
import {
  REFRESH_ALARM_NAME,
  REFRESH_ALARM_PERIOD_MINUTES
} from "../../src/extension/runtime/config.js";
import {
  INTEGRATION_V1,
  createFakeNativeRuntime,
  createFakeProxy,
  nativeHostFailing,
  fireInstalled,
  fireStartup,
  nativeHostServing,
  routingState
} from "./fakes.js";

const EXTENSION_ID = "lfaekfalhkgmbfdjjlfcalanhijeaien";
const SLICE8_GEN = "75f5c435-6ac5-45a5-876b-042a6376635e";
const ENDPOINT_A = Object.freeze({ host: "127.0.0.1", port: 58251 });
const ENDPOINT_B = Object.freeze({ host: "127.0.0.1", port: 54254 });

function event() {
  const listeners = [];
  return { listeners, addListener: (listener) => listeners.push(listener) };
}

function waitTicks(n = 4) {
  return new Promise((resolve) => {
    let left = n;
    const step = () => {
      if (--left <= 0) resolve();
      else setImmediate(step);
    };
    setImmediate(step);
  });
}

function createFakeAlarms() {
  const store = new Map();
  const onAlarm = event();
  const api = {
    get: (name, cb) => setImmediate(() => cb(store.get(name))),
    create: (name, info, cb = () => {}) => {
      store.set(name, { name, ...info });
      setImmediate(cb);
    },
    onAlarm
  };
  return { store, api, onAlarm };
}

function createChromeMock(options = {}) {
  const proxy = createFakeProxy();
  const storage = {};
  const alarms = createFakeAlarms();
  const chrome = {
    runtime: { id: EXTENSION_ID, lastError: undefined, onInstalled: event(), onStartup: event(), onMessage: event() },
    proxy: { onProxyError: event(), settings: {} },
    storage: { local: {} },
    alarms: alarms.api
  };

  function callback(promise, done) {
    promise.then(
      (value) => setImmediate(() => done(value)),
      (error) => setImmediate(() => {
        chrome.runtime.lastError = { message: error.message };
        try { done(undefined); } finally { chrome.runtime.lastError = undefined; }
      }));
  }

  chrome.proxy.settings.get = (details, done) => callback(proxy.get(), done);
  chrome.proxy.settings.set = (details, done) => callback(proxy.set(details.value), done);
  chrome.proxy.settings.clear = (details, done) => callback(proxy.clear(), done);
  chrome.storage.local.get = (key, done) => callback(Promise.resolve({ [key]: storage[key] && JSON.parse(storage[key]) }), done);
  chrome.storage.local.set = (items, done) => {
    for (const [key, value] of Object.entries(items)) storage[key] = JSON.stringify(value);
    callback(Promise.resolve(), done);
  };

  if (options.sendNativeMessage) {
    chrome.runtime.sendNativeMessage = options.sendNativeMessage;
  }

  return { chrome, proxy, storage, alarms };
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

function pacData(proxy) {
  const last = proxy.calls.set.at(-1);
  return last && last.pacScript && last.pacScript.data;
}

function ipifyState(revision = 1) {
  return routingState(revision, {
    rules: [{
      id: "ipify",
      name: "ipify",
      host: "api.ipify.org",
      matchType: "ExactHost",
      routeMode: "VPN",
      enabled: true,
      source: "User",
      notes: null
    }]
  });
}

function readyEndpoint(endpoint) {
  return { status: "Ready", endpoint: { ...endpoint } };
}

describe("refresh alarm registration", () => {
  test("source manifest contains alarms permission", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "src/extension/manifest.json"), "utf8"));
    assert.ok(manifest.permissions.includes("alarms"));
  });

  test("onInstalled and onStartup ensure refresh alarm with a 1 minute period", async () => {
    const mock = createChromeMock();
    globalThis.chrome = mock.chrome;
    try {
      await import("../../src/extension/background.js");
      await waitTicks();
      assert.equal(mock.alarms.store.has(REFRESH_ALARM_NAME), true);
      assert.equal(mock.alarms.store.get(REFRESH_ALARM_NAME).periodInMinutes, REFRESH_ALARM_PERIOD_MINUTES);

      mock.alarms.store.delete(REFRESH_ALARM_NAME);
      fireInstalled(mock.chrome.runtime);
      await waitTicks();
      assert.equal(mock.alarms.store.has(REFRESH_ALARM_NAME), true);

      mock.alarms.store.delete(REFRESH_ALARM_NAME);
      fireStartup(mock.chrome.runtime);
      await waitTicks();
      assert.equal(mock.alarms.store.has(REFRESH_ALARM_NAME), true);
    } finally {
      delete globalThis.chrome;
    }
  });

  test("irrelevant alarm does not fetch; refresh alarm syncs native state", async () => {
    const outDir = path.join(DIST_ROOT, ".test-alarm-" + process.pid, "extension");
    await buildExtension({ mode: "native", outDir });
    const state = ipifyState(42);
    const host = { handler: nativeHostServing(state, { integration: INTEGRATION_V1 }) };
    const native = createFakeNativeRuntime((name, message) => host.handler(name, message));
    const mock = createChromeMock({
      sendNativeMessage: (name, message, callback) =>
        native.sendNativeMessage(name, message, (response) => {
          mock.chrome.runtime.lastError = native.lastError;
          try { callback(response); } finally { mock.chrome.runtime.lastError = undefined; }
        })
    });
    globalThis.chrome = mock.chrome;
    try {
      await import(pathToFileURL(path.join(outDir, "extension/background.js")).href);
      fireInstalled(mock.chrome.runtime);
      const installed = await send(mock.chrome, { command: "status" });
      assert.equal(installed.diagnostics.status, "APPLIED");
      const afterInstall = native.calls.length;
      assert.ok(afterInstall > 0);

      mock.alarms.onAlarm.listeners[0]({ name: "otherAlarm" });
      await waitTicks();
      assert.equal(native.calls.length, afterInstall);

      mock.alarms.onAlarm.listeners[0]({ name: REFRESH_ALARM_NAME });
      await waitTicks();
      assert.ok(native.calls.length > afterInstall);
    } finally {
      delete globalThis.chrome;
    }
  });
});

describe("alarm-driven endpoint recovery", () => {
  test("Slice 8 regression: same generation/revision endpoint 58251 → 54254 via alarm only", async () => {
    const outDir = path.join(DIST_ROOT, ".test-ab-" + process.pid, "extension");
    await buildExtension({ mode: "native", outDir });
    const state = ipifyState(1);
    const host = {
      handler: nativeHostServing(state, {
        generation: SLICE8_GEN,
        browserProxy: readyEndpoint(ENDPOINT_A),
        integration: INTEGRATION_V1
      })
    };
    const native = createFakeNativeRuntime((name, message) => host.handler(name, message));
    const mock = createChromeMock({
      sendNativeMessage: (name, message, callback) =>
        native.sendNativeMessage(name, message, (response) => {
          mock.chrome.runtime.lastError = native.lastError;
          try { callback(response); } finally { mock.chrome.runtime.lastError = undefined; }
        })
    });
    globalThis.chrome = mock.chrome;
    try {
      await import(pathToFileURL(path.join(outDir, "extension/background.js")).href);
      fireInstalled(mock.chrome.runtime);
      let status = await send(mock.chrome, { command: "status" });
      assert.equal(status.diagnostics.status, "APPLIED");
      assert.match(pacData(mock.proxy), /SOCKS5 127\.0\.0\.1:58251/);
      assert.equal(mock.proxy.calls.set.length, 1);

      const callsAfterInstall = native.calls.length;
      host.handler = nativeHostServing(state, {
        generation: SLICE8_GEN,
        browserProxy: readyEndpoint(ENDPOINT_B),
        integration: INTEGRATION_V1
      });

      mock.alarms.onAlarm.listeners[0]({ name: REFRESH_ALARM_NAME });
      status = await send(mock.chrome, { command: "status" });
      assert.ok(native.calls.length > callsAfterInstall);
      assert.match(pacData(mock.proxy), /SOCKS5 127\.0\.0\.1:54254/);
      assert.doesNotMatch(pacData(mock.proxy), /58251/);
      assert.equal(status.ok, true);
      assert.equal(status.diagnostics.lastApplied.revision, 1);
      assert.equal(status.diagnostics.status, "APPLIED");
    } finally {
      delete globalThis.chrome;
    }
  });

  test("Service unavailable on alarm keeps PAC A; next alarm applies endpoint B without DIRECT", async () => {
    const outDir = path.join(DIST_ROOT, ".test-lkg-" + process.pid, "extension");
    await buildExtension({ mode: "native", outDir });
    const state = ipifyState(1);
    const host = {
      handler: nativeHostServing(state, {
        generation: SLICE8_GEN,
        browserProxy: readyEndpoint(ENDPOINT_A),
        integration: INTEGRATION_V1
      })
    };
    const native = createFakeNativeRuntime((name, message) => host.handler(name, message));
    const mock = createChromeMock({
      sendNativeMessage: (name, message, callback) =>
        native.sendNativeMessage(name, message, (response) => {
          mock.chrome.runtime.lastError = native.lastError;
          try { callback(response); } finally { mock.chrome.runtime.lastError = undefined; }
        })
    });
    globalThis.chrome = mock.chrome;
    try {
      await import(pathToFileURL(path.join(outDir, "extension/background.js")).href);
      fireInstalled(mock.chrome.runtime);
      let status = await send(mock.chrome, { command: "status" });
      assert.equal(status.diagnostics.status, "APPLIED");
      const pacA = pacData(mock.proxy);
      assert.match(pacA, /58251/);

      host.handler = nativeHostFailing("service_unavailable", "VPN Route Service is unavailable.");
      mock.alarms.onAlarm.listeners[0]({ name: REFRESH_ALARM_NAME });
      status = await send(mock.chrome, { command: "status" });
      assert.equal(pacData(mock.proxy), pacA);
      assert.equal(status.diagnostics.status, "APPLIED");
      assert.equal(status.protection, "LAST_KNOWN_GOOD");

      host.handler = nativeHostServing(state, {
        generation: SLICE8_GEN,
        browserProxy: readyEndpoint(ENDPOINT_B),
        integration: INTEGRATION_V1
      });
      mock.alarms.onAlarm.listeners[0]({ name: REFRESH_ALARM_NAME });
      status = await send(mock.chrome, { command: "status" });
      assert.match(pacData(mock.proxy), /54254/);
      assert.equal(status.diagnostics.status, "APPLIED");
      assert.equal(status.protection, "CURRENT");
      for (const call of mock.proxy.calls.set) {
        assert.notEqual(call.mode, "direct");
        assert.ok(call.pacScript);
      }
    } finally {
      delete globalThis.chrome;
    }
  });

  test("refresh scheduling uses chrome.alarms, not in-memory timers", () => {
    const source = readFileSync(path.join(ROOT, "src/extension/runtime/refresh-alarm.js"), "utf8");
    assert.match(source, /\bchromeApi\.alarms\b/);
    assert.doesNotMatch(source, /\bsetInterval\b/);
    assert.doesNotMatch(source, /\bsetTimeout\b/);
  });
});
