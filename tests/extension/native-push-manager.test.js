import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { wireNativePushManager } from "../../src/extension/runtime/native-push-manager.js";
import { installRefreshAlarmHooks } from "../../src/extension/runtime/refresh-alarm.js";
import { REFRESH_ALARM_NAME } from "../../src/extension/runtime/config.js";

const GEN = "9b2f6c1e-1d2a-4f57-9a43-3f2a9d7c1b10";

function createPort(events = []) {
  const listeners = { message: [], disconnect: [] };
  let idx = 0;
  return {
    posted: [],
    disconnected: false,
    postMessage(message) {
      this.posted.push(message);
      if (message.command === "watchEvents") {
        setImmediate(() => {
          while (idx < events.length) {
            const payload = events[idx++];
            listeners.message.forEach((fn) => fn(payload));
          }
        });
      }
    },
    disconnect() { this.disconnected = true; },
    onMessage: { addListener(fn) { listeners.message.push(fn); } },
    onDisconnect: { addListener(fn) { listeners.disconnect.push(fn); } },
    emitDisconnect() { listeners.disconnect.forEach((fn) => fn()); }
  };
}

function createCoordinator(statusView, syncImpl) {
  let syncCalls = 0;
  return {
    syncCalls: () => syncCalls,
    status: async () => statusView,
    sync: async (reason) => {
      syncCalls++;
      return syncImpl ? syncImpl(reason, syncCalls) : statusView;
    }
  };
}

function createChrome(portFactory) {
  const alarms = { created: [], listeners: [], get(name, cb) { cb({ name, periodInMinutes: 15 }); }, create(name, info, cb) { alarms.created.push({ name, info }); cb(); }, onAlarm: { addListener(fn) { alarms.listeners.push(fn); } } };
  return {
    chrome: {
      runtime: {
        connectNative: () => portFactory(),
        id: "test-extension"
      },
      alarms
    },
    alarms
  };
}

describe("native push manager", () => {
  test("service push triggers coordinator sync", async () => {
    const port = createPort([
      { ok: true, result: { type: "browserRoutingChanged", stateGeneration: GEN, revision: 44 } }
    ]);
    const coordinator = createCoordinator({
      source: { fetchedIdentity: { stateGeneration: GEN, revision: 43 }, integration: { capabilities: ["browserRoutingPush"] } }
    });
    const { chrome } = createChrome(() => port);
    wireNativePushManager(chrome, coordinator, { mode: "Native" });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(coordinator.syncCalls(), 1);
    assert.equal(port.posted.length, 1);
    assert.equal(port.posted[0].command, "watchEvents");
  });

  test("dedup skips sync when revision already current", async () => {
    const port = createPort([
      { ok: true, result: { type: "browserRoutingChanged", stateGeneration: GEN, revision: 44 } }
    ]);
    const coordinator = createCoordinator({
      source: { fetchedIdentity: { stateGeneration: GEN, revision: 44 }, integration: { capabilities: ["browserRoutingPush"] } }
    });
    const { chrome } = createChrome(() => port);
    wireNativePushManager(chrome, coordinator, { mode: "Native" });
    await new Promise((r) => setImmediate(r));
    assert.equal(coordinator.syncCalls(), 0);
  });

  test("push unavailable without capability does not connect", async () => {
    let connects = 0;
    const coordinator = createCoordinator({
      source: { integration: { capabilities: ["browserRoutingWrite"] } }
    });
    const { chrome } = createChrome(() => { connects++; return createPort(); });
    wireNativePushManager(chrome, coordinator, { mode: "Native" });
    await new Promise((r) => setImmediate(r));
    assert.equal(connects, 0);
  });

  test("reconnect uses backoff after disconnect", async () => {
    const ports = [];
    const coordinator = createCoordinator({
      source: { fetchedIdentity: null, integration: { capabilities: ["browserRoutingPush"] } }
    });
    const { chrome } = createChrome(() => {
      const port = createPort();
      ports.push(port);
      return port;
    });
    wireNativePushManager(chrome, coordinator, { mode: "Native" });
    await new Promise((r) => setImmediate(r));
    assert.equal(ports.length, 1);
    ports[0].emitDisconnect();
    await new Promise((r) => setTimeout(r, 1100));
    assert.ok(ports.length >= 2, "expected reconnect after backoff");
  });

  test("refresh alarm hooks still register when push manager is wired", () => {
    const { chrome, alarms } = createChrome(() => createPort());
    const coordinator = createCoordinator({ source: { integration: { capabilities: [] } } });
    installRefreshAlarmHooks(chrome, () => () => {});
    wireNativePushManager(chrome, coordinator, { mode: "Native" });
    assert.ok(alarms.created.some((entry) => entry.name === REFRESH_ALARM_NAME));
  });
});
