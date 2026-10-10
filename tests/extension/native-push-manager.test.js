import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { wireNativePushManager } from "../../src/extension/runtime/native-push-manager.js";
import { installRefreshAlarmHooks } from "../../src/extension/runtime/refresh-alarm.js";
import { REFRESH_ALARM_NAME } from "../../src/extension/runtime/config.js";

const GEN = "9b2f6c1e-1d2a-4f57-9a43-3f2a9d7c1b10";
const PUSH_CAPS = Object.freeze(["browserRoutingPush"]);

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
  let connectCalls = 0;
  return {
    chrome: {
      runtime: {
        connectNative: () => {
          connectCalls++;
          return portFactory(connectCalls);
        },
        id: "test-extension"
      },
      alarms
    },
    alarms,
    connectCalls: () => connectCalls
  };
}

const statusWithPush = {
  source: { fetchedIdentity: null, integration: { capabilities: PUSH_CAPS } }
};

describe("native push manager", () => {
  test("service push triggers coordinator sync", async () => {
    const port = createPort([
      { ok: true, result: { type: "browserRoutingChanged", stateGeneration: GEN, revision: 44 } }
    ]);
    const coordinator = createCoordinator({
      source: { fetchedIdentity: { stateGeneration: GEN, revision: 43 }, integration: { capabilities: PUSH_CAPS } }
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
      source: { fetchedIdentity: { stateGeneration: GEN, revision: 44 }, integration: { capabilities: PUSH_CAPS } }
    });
    const { chrome } = createChrome(() => port);
    wireNativePushManager(chrome, coordinator, { mode: "Native" });
    await new Promise((r) => setImmediate(r));
    assert.equal(coordinator.syncCalls(), 0);
  });

  test("push unavailable without capability does not connect", async () => {
    const { chrome, connectCalls } = createChrome(() => createPort());
    const coordinator = createCoordinator({
      source: { integration: { capabilities: ["browserRoutingWrite"] } }
    });
    wireNativePushManager(chrome, coordinator, { mode: "Native" });
    await new Promise((r) => setImmediate(r));
    assert.equal(connectCalls(), 0);
  });

  test("initial wire with push enabled creates exactly one connectNative", async () => {
    const { chrome, connectCalls } = createChrome(() => createPort());
    wireNativePushManager(chrome, createCoordinator(statusWithPush), { mode: "Native" });
    await new Promise((r) => setImmediate(r));
    assert.equal(connectCalls(), 1);
  });

  test("repeat updateCapabilities while push enabled does not connect again", async () => {
    const { chrome, connectCalls } = createChrome(() => createPort());
    const coordinator = createCoordinator(statusWithPush);
    const manager = wireNativePushManager(chrome, coordinator, { mode: "Native" });
    await new Promise((r) => setImmediate(r));
    assert.equal(connectCalls(), 1);
    manager.updateCapabilities([...PUSH_CAPS]);
    manager.updateCapabilities(["browserRoutingPush", "browserRoutingWrite"]);
    assert.equal(connectCalls(), 1);
  });

  test("cached then fresh capability refresh keeps one live port", async () => {
    let statusReads = 0;
    const coordinator = {
      status: async () => {
        statusReads++;
        return statusWithPush;
      },
      sync: async () => statusWithPush
    };
    const { chrome, connectCalls } = createChrome(() => createPort());
    const manager = wireNativePushManager(chrome, coordinator, { mode: "Native" });
    await new Promise((r) => setImmediate(r));
    assert.equal(connectCalls(), 1);
    manager.updateCapabilities(PUSH_CAPS);
    assert.equal(connectCalls(), 1);
    assert.ok(statusReads >= 1);
  });

  test("disabling push disconnects port and does not reconnect", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const port = createPort();
    const { chrome, connectCalls } = createChrome(() => port);
    const manager = wireNativePushManager(chrome, createCoordinator(statusWithPush), { mode: "Native" });
    await new Promise((r) => setImmediate(r));
    assert.equal(connectCalls(), 1);
    manager.updateCapabilities(["browserRoutingWrite"]);
    assert.equal(port.disconnected, true);
    mock.timers.tick(30000);
    assert.equal(connectCalls(), 1);
    mock.timers.reset();
  });

  test("re-enabling push creates exactly one new port", async () => {
    const { chrome, connectCalls } = createChrome(() => createPort());
    const manager = wireNativePushManager(chrome, createCoordinator(statusWithPush), { mode: "Native" });
    await new Promise((r) => setImmediate(r));
    manager.updateCapabilities(["browserRoutingWrite"]);
    manager.updateCapabilities(PUSH_CAPS);
    assert.equal(connectCalls(), 2);
  });

  test("reconnect uses backoff after disconnect", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const ports = [];
    const { chrome, connectCalls } = createChrome(() => {
      const port = createPort();
      ports.push(port);
      return port;
    });
    wireNativePushManager(chrome, createCoordinator(statusWithPush), { mode: "Native" });
    await new Promise((r) => setImmediate(r));
    assert.equal(connectCalls(), 1);
    ports[0].emitDisconnect();
    mock.timers.tick(1000);
    assert.equal(connectCalls(), 2);
    mock.timers.reset();
  });

  test("stale port onDisconnect after reconnect does not clear active port", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const portA = createPort();
    const portB = createPort();
    let n = 0;
    const { chrome, connectCalls } = createChrome(() => (n++ === 0 ? portA : portB));
    wireNativePushManager(chrome, createCoordinator(statusWithPush), { mode: "Native" });
    await new Promise((r) => setImmediate(r));
    portA.emitDisconnect();
    mock.timers.tick(1000);
    assert.equal(connectCalls(), 2);
    portA.emitDisconnect();
    mock.timers.tick(1000);
    assert.equal(connectCalls(), 2);
    mock.timers.reset();
  });

  test("capability refresh during pending reconnect does not duplicate ports", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const ports = [];
    const { chrome, connectCalls } = createChrome(() => {
      const port = createPort();
      ports.push(port);
      return port;
    });
    const manager = wireNativePushManager(chrome, createCoordinator(statusWithPush), { mode: "Native" });
    await new Promise((r) => setImmediate(r));
    ports[0].emitDisconnect();
    mock.timers.tick(500);
    assert.equal(connectCalls(), 1);
    manager.updateCapabilities(PUSH_CAPS);
    assert.equal(connectCalls(), 2);
    mock.timers.tick(30000);
    assert.equal(connectCalls(), 2);
    mock.timers.reset();
  });

  test("refresh alarm hooks still register when push manager is wired", () => {
    const { chrome, alarms } = createChrome(() => createPort());
    const coordinator = createCoordinator({ source: { integration: { capabilities: [] } } });
    installRefreshAlarmHooks(chrome, () => () => {});
    wireNativePushManager(chrome, coordinator, { mode: "Native" });
    assert.ok(alarms.created.some((entry) => entry.name === REFRESH_ALARM_NAME));
  });
});
