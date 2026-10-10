import { NATIVE_HOST_NAME } from "./config.js";

const BACKOFF_MS = Object.freeze([1000, 2000, 5000, 10000, 30000]);
const PUSH_CAPABILITY = "browserRoutingPush";
const KNOWN_EVENT_TYPES = new Set(["browserRoutingChanged", "serviceAvailable"]);

/**
 * @param {typeof chrome} chromeApi
 * @param {{ sync(reason: string): Promise<any>, status(): Promise<any> }} coordinator
 * @param {{ mode: string, report?: (label: string) => (error: unknown) => void }} options
 */
export function wireNativePushManager(chromeApi, coordinator, options) {
  if (options.mode !== "Native") return;
  const report = options.report || (() => () => {});
  const runtime = chromeApi.runtime;
  if (!runtime || typeof runtime.connectNative !== "function") return;

  let backoffIndex = 0;
  let port = null;
  let stopped = false;
  let pushEnabled = false;
  let reconnectTimer = null;

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped || !pushEnabled || port || reconnectTimer !== null) return;
    const delay = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)];
    backoffIndex = Math.min(backoffIndex + 1, BACKOFF_MS.length - 1);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function resetBackoff() {
    backoffIndex = 0;
  }

  async function shouldSync(event) {
    const view = await coordinator.status();
    const identity = view.source && view.source.fetchedIdentity;
    if (!identity) return true;
    return identity.stateGeneration !== event.stateGeneration || identity.revision !== event.revision;
  }

  async function onEvent(message) {
    if (!message || message.ok !== true || !message.result) return;
    const result = message.result;
    if (!KNOWN_EVENT_TYPES.has(result.type)) return;
    if (typeof result.stateGeneration !== "string" || typeof result.revision !== "number") return;
    if (!(await shouldSync(result))) return;
    coordinator.sync("service-push").catch(report("sync on service push"));
  }

  function connect() {
    if (stopped || !pushEnabled || port) return;
    clearReconnectTimer();
    let connectedPort;
    try {
      connectedPort = runtime.connectNative(NATIVE_HOST_NAME);
    } catch (error) {
      scheduleReconnect();
      return;
    }
    if (!connectedPort) {
      scheduleReconnect();
      return;
    }

    port = connectedPort;

    connectedPort.onMessage.addListener((message) => {
      resetBackoff();
      void onEvent(message);
    });
    connectedPort.onDisconnect.addListener(() => {
      if (port !== connectedPort) return;
      port = null;
      scheduleReconnect();
    });

    try {
      connectedPort.postMessage({
        protocolVersion: 1,
        requestId: "push-" + Date.now().toString(36),
        command: "watchEvents"
      });
    } catch (error) {
      try { connectedPort.disconnect(); } catch (_) { /* ignore */ }
      if (port === connectedPort) port = null;
      scheduleReconnect();
    }
  }

  function updateCapabilities(capabilities) {
    if (!Array.isArray(capabilities)) return;
    const nextEnabled = capabilities.includes(PUSH_CAPABILITY);
    if (nextEnabled === pushEnabled) {
      if (nextEnabled && port) return;
      if (!nextEnabled && !port) return;
    }
    pushEnabled = nextEnabled;
    if (pushEnabled) {
      connect();
      return;
    }
    clearReconnectTimer();
    if (port) {
      try { port.disconnect(); } catch (_) { /* ignore */ }
      port = null;
    }
  }

  function refreshCapabilities() {
    coordinator.status().then((view) => {
      updateCapabilities(view.source && view.source.integration && view.source.integration.capabilities);
    }).catch(report("push capability probe"));
  }

  refreshCapabilities();

  return Object.freeze({
    updateCapabilities,
    refreshCapabilities,
    stop() {
      stopped = true;
      clearReconnectTimer();
      if (port) {
        try { port.disconnect(); } catch (_) { /* ignore */ }
        port = null;
      }
    }
  });
}
