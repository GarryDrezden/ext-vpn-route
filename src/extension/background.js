import { compilePacScript } from "../pac/index.js";
import { createChromeProxy, createChromeStorage } from "./runtime/chrome-adapter.js";
import { DIAGNOSTICS_STORAGE_KEY, PHASE3_PROXY_ENDPOINT } from "./runtime/config.js";
import { createProxyController } from "./runtime/proxy-controller.js";
import { FIXTURE_NAME, SMOKE_STATE } from "./state/smoke-state.js";

const controller = createProxyController({
  proxy: createChromeProxy(chrome),
  storage: createChromeStorage(chrome, DIAGNOSTICS_STORAGE_KEY),
  loadState: () => SMOKE_STATE,
  compile: compilePacScript,
  endpoint: PHASE3_PROXY_ENDPOINT
});

function report(label) {
  return (error) => console.error("[VPN Route] " + label + " failed: " + (error && error.message));
}

chrome.runtime.onInstalled.addListener(() => {
  controller.apply("installed").catch(report("apply on install"));
});

chrome.runtime.onStartup.addListener(() => {
  controller.apply("startup").catch(report("apply on startup"));
});

if (chrome.proxy && chrome.proxy.onProxyError) {
  chrome.proxy.onProxyError.addListener((details) => {
    controller.recordProxyError(details).catch(report("record proxy error"));
  });
}

const COMMANDS = Object.freeze({
  status: () => controller.refresh(),
  reapply: () => controller.apply("popup"),
  clear: () => controller.clear()
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id || sender.tab) return false;
  const command = message && typeof message.command === "string" && Object.prototype.hasOwnProperty.call(COMMANDS, message.command)
    ? COMMANDS[message.command]
    : null;
  if (!command) return false;

  command().then(
    (diagnostics) => sendResponse({ ok: true, fixture: FIXTURE_NAME, diagnostics }),
    (error) => sendResponse({ ok: false, fixture: FIXTURE_NAME, error: String(error && error.message) })
  );
  return true;
});
