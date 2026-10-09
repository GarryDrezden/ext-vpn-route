import { compilePacScript } from "../pac/index.js";
import { createChromeProxy, createChromeStorage } from "./runtime/chrome-adapter.js";
import { DIAGNOSTICS_STORAGE_KEY, SOURCE_STORAGE_KEY } from "./runtime/config.js";
import { createProxyController } from "./runtime/proxy-controller.js";
import { createRoutingCoordinator } from "./runtime/routing-coordinator.js";
import { installRefreshAlarmHooks, wireRefreshAlarmListener } from "./runtime/refresh-alarm.js";
import { wireNativePushManager } from "./runtime/native-push-manager.js";
import {
  buildFixtureRulesPanelView,
  buildRulesPanelView,
  executeRulesMutation
} from "./runtime/rules-panel.js";
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

installRefreshAlarmHooks(chrome, report);
wireRefreshAlarmListener(chrome, coordinator, report);
const nativePush = wireNativePushManager(chrome, coordinator, { mode: source.mode, report });

function syncAndRefreshPush(reason) {
  return coordinator.sync(reason).then((view) => {
    if (nativePush) {
      const caps = view.source && view.source.integration && view.source.integration.capabilities;
      nativePush.updateCapabilities(caps);
    }
    return view;
  });
}

chrome.runtime.onInstalled.addListener(() => {
  syncAndRefreshPush("installed").catch(report("sync on install"));
});

chrome.runtime.onStartup.addListener(() => {
  syncAndRefreshPush("startup").catch(report("sync on startup"));
});

if (chrome.proxy && chrome.proxy.onProxyError) {
  chrome.proxy.onProxyError.addListener((details) => {
    controller.recordProxyError(details).catch(report("record proxy error"));
  });
}

function formatWorkerView(view) {
  return {
    mode: view.mode,
    fixture: source.fixture,
    protection: view.protection,
    source: view.source,
    diagnostics: view.diagnostics
  };
}

async function loadRulesPanel() {
  if (source.mode === "Native" && source.provider) {
    return buildRulesPanelView(await source.provider.getSnapshot());
  }
  return buildFixtureRulesPanelView(source.builtInState);
}

async function popupStatus() {
  const view = await coordinator.status();
  const rulesPanel = await loadRulesPanel();
  return { ok: true, ...formatWorkerView(view), rulesPanel };
}

async function rulesMutate(message) {
  if (!source.writer || !source.provider) {
    return {
      ok: false,
      code: "write_unsupported",
      panel: buildFixtureRulesPanelView(source.builtInState),
      userMessage: null
    };
  }
  return executeRulesMutation({
    getSnapshot: () => source.provider.getSnapshot(),
    writer: source.writer,
    sync: (reason) => coordinator.sync(reason),
    formatView: formatWorkerView
  }, message.action, message);
}

const COMMANDS = Object.freeze({
  status: () => popupStatus(),
  reapply: async () => {
    const view = await coordinator.sync("popup");
    return { ok: true, ...formatWorkerView(view), rulesPanel: await loadRulesPanel() };
  },
  clear: async () => {
    const view = await coordinator.clear();
    return { ok: true, ...formatWorkerView(view), rulesPanel: await loadRulesPanel() };
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id || sender.tab) return false;
  if (message && message.command === "rulesMutate") {
    rulesMutate(message).then(
      (result) => sendResponse(result),
      (error) => sendResponse({ ok: false, error: String(error && error.message) })
    );
    return true;
  }
  const command = message && typeof message.command === "string" && Object.prototype.hasOwnProperty.call(COMMANDS, message.command)
    ? COMMANDS[message.command]
    : null;
  if (!command) return false;

  command().then(
    (result) => sendResponse(result),
    (error) => sendResponse({ ok: false, mode: source.mode, fixture: source.fixture, error: String(error && error.message) })
  );
  return true;
});
