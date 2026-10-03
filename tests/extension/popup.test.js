import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { ROOT } from "../../scripts/build-extension.js";

const POPUP_DIR = path.join(ROOT, "src/extension/popup");

function fakeDocument() {
  const html = readFileSync(path.join(POPUP_DIR, "popup.html"), "utf8");
  const elements = new Map();
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"([^>]*)>([^<]*)/g)) {
    elements.set(match[2], {
      tag: match[1],
      textContent: match[4],
      className: "",
      hidden: /\bhidden\b/.test(match[0]),
      disabled: false,
      listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }
    });
  }
  return {
    elements,
    getElementById(id) {
      const element = elements.get(id);
      if (!element) throw new Error("popup.js uses missing element #" + id);
      return element;
    }
  };
}

async function renderPopup(response) {
  const document = fakeDocument();
  const sent = [];
  globalThis.document = document;
  globalThis.chrome = {
    runtime: {
      id: "lfaekfalhkgmbfdjjlfcalanhijeaien",
      lastError: undefined,
      sendMessage(message, callback) {
        sent.push(message);
        setImmediate(() => callback(response));
      }
    }
  };
  try {
    await import(pathToFileURL(path.join(POPUP_DIR, "popup.js")).href + "?r=" + Math.random());
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    delete globalThis.document;
    delete globalThis.chrome;
  }
  const text = (id) => document.elements.get(id).textContent;
  return { document, sent, text, all: [...document.elements.values()].map((e) => e.textContent).join("\n") };
}

const appliedDiagnostics = {
  status: "APPLIED",
  proxyApi: "AVAILABLE",
  levelOfControl: "controlled_by_this_extension",
  state: { schemaVersion: 1, revision: 43, defaultRoute: "Direct", ruleCount: 2, enabledRuleCount: 2 },
  compile: { status: "COMPILED", revision: 43, byteLength: 4000, endpoint: "127.0.0.1:17891" },
  active: { pac: "CURRENT", revision: 43, mode: "pac_script", mandatory: true, verification: "data_match" },
  lastApplied: { revision: 43 },
  lastOperation: { kind: "apply:popup", result: "APPLIED", at: "t", message: null },
  lastError: null,
  lastProxyError: null
};

test("popup renders Native diagnostics without rules or hostnames", async () => {
  const popup = await renderPopup({
    ok: true,
    mode: "Native",
    fixture: null,
    protection: "LAST_KNOWN_GOOD",
    source: {
      hostName: "com.vpnroute.browser",
      protocolVersion: 1,
      transport: "AVAILABLE",
      service: "UNAVAILABLE",
      lastFetch: { result: "ERROR", at: "2026-10-03T10:00:00.000Z", errorCode: "host_error", hostErrorCode: "service_unavailable" },
      fetchedRevision: 43,
      lastTransportError: null,
      lastDecision: { kind: "fetch_failed", at: "t", message: "service_unavailable" },
      lineage: { lastAppliedRevision: 43 }
    },
    diagnostics: appliedDiagnostics
  });

  assert.deepEqual(popup.sent, [{ command: "status" }]);
  assert.equal(popup.document.elements.get("native-section").hidden, false);
  assert.equal(popup.text("state-source"), "Native");
  assert.equal(popup.text("protection"), "LAST_KNOWN_GOOD");
  assert.equal(popup.text("native-host"), "com.vpnroute.browser");
  assert.equal(popup.text("native-transport"), "AVAILABLE");
  assert.equal(popup.text("native-protocol"), "1");
  assert.equal(popup.text("native-service"), "UNAVAILABLE");
  assert.match(popup.text("native-last-fetch"), /^ERROR \(service_unavailable\)/);
  assert.equal(popup.text("native-fetched-revision"), "43");
  assert.equal(popup.text("applied-revision"), "43");
  assert.equal(popup.text("reapply"), "Refresh state & apply");
  assert.equal(popup.all.includes("youtube"), false);
});

test("popup renders Fixture mode and hides the native section", async () => {
  const popup = await renderPopup({
    ok: true, mode: "Fixture", fixture: "normal", protection: "CURRENT", source: null, diagnostics: appliedDiagnostics
  });

  assert.equal(popup.document.elements.get("native-section").hidden, true);
  assert.equal(popup.text("state-source"), "Fixture (normal)");
  assert.equal(popup.text("protection"), "CURRENT");
  assert.equal(popup.text("reapply"), "Reapply PAC");
});
