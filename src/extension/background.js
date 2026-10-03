import { compilePacScript } from "../pac/index.js";
import { createChromeProxy, createChromeStorage } from "./runtime/chrome-adapter.js";
import { DIAGNOSTICS_STORAGE_KEY, SOURCE_STORAGE_KEY } from "./runtime/config.js";
import { createProxyController } from "./runtime/proxy-controller.js";
import { createRoutingCoordinator } from "./runtime/routing-coordinator.js";
import { createStateSource } from "./state/source.js";

const source = createStateSource(chrome);

const controller = createProxyController({
  proxy: createChromeProxy(chrome),
  storage: createChromeStorage(chrome, DIAGNOSTICS_STORAGE_KEY),
  compile: compilePacScript,
  ...(source.builtInState || {})
});

const coordinator = createRoutingCoordinator({
  mode: source.mode,
  controller,
  provider: source.provider || undefined,
  storage: source.provider ? createChromeStorage(chrome, SOURCE_STORAGE_KEY) : undefined
});

function report(label) {
  return (error) => console.error("[VPN Route] " + label + " failed: " + (error && error.message));
}

chrome.runtime.onInstalled.addListener(() => {
  coordinator.sync("installed").catch(report("sync on install"));
});

chrome.runtime.onStartup.addListener(() => {
  coordinator.sync("startup").catch(report("sync on startup"));
});

if (chrome.proxy && chrome.proxy.onProxyError) {
  chrome.proxy.onProxyError.addListener((details) => {
    controller.recordProxyError(details).catch(report("record proxy error"));
  });
}

const COMMANDS = Object.freeze({
  status: () => coordinator.status(),
  reapply: () => coordinator.sync("popup"),
  clear: () => coordinator.clear()
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id || sender.tab) return false;
  const command = message && typeof message.command === "string" && Object.prototype.hasOwnProperty.call(COMMANDS, message.command)
    ? COMMANDS[message.command]
    : null;
  if (!command) return false;

  command().then(
    (result) => sendResponse({
      ok: true,
      mode: result.mode,
      fixture: source.fixture,
      protection: result.protection,
      source: result.source,
      diagnostics: result.diagnostics
    }),
    (error) => sendResponse({ ok: false, mode: source.mode, fixture: source.fixture, error: String(error && error.message) })
  );
  return true;
});
