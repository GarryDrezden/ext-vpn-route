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
      state: "UNKNOWN",
      browserProxy: "UNKNOWN",
      lastFetch: { result: "ERROR", at: "2026-10-03T10:00:00.000Z", errorCode: "host_error", hostErrorCode: "service_unavailable", identity: null, stats: null },
      fetchedIdentity: { stateGeneration: "9b2f6c1e-1d2a-4f57-9a43-3f2a9d7c1b10", revision: 43 },
      lastTransportError: null,
      lastDecision: { kind: "fetch_failed", at: "t", message: "service_unavailable" },
      lastLineageChange: null,
      lineage: {
        currentGeneration: "9b2f6c1e-1d2a-4f57-9a43-3f2a9d7c1b10", acceptedRevision: 43,
        appliedIdentity: { stateGeneration: "9b2f6c1e-1d2a-4f57-9a43-3f2a9d7c1b10", revision: 43 }, retiredGenerations: []
      }
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
  assert.equal(popup.text("native-fetched-revision"), "revision 43");
  assert.equal(popup.text("native-generation"), "9b2f6c1e-1d2a-4f57-9a43-3f2a9d7c1b10");
  assert.equal(popup.text("native-applied-identity"), "revision 43");
  assert.equal(popup.text("native-lineage-change"), "none");
  assert.equal(popup.text("native-pages"), "—");
  assert.equal(popup.text("applied-revision"), "43");
  assert.equal(popup.text("reapply"), "Refresh state & apply");
  assert.equal(popup.all.includes("youtube"), false);
});

test("popup shows State AVAILABLE with Browser proxy UNAVAILABLE, a new lineage and page stats", async () => {
  const genA = "9b2f6c1e-1d2a-4f57-9a43-3f2a9d7c1b10";
  const genB = "4c1d8e2f-7a6b-4e3c-9d2a-1b0f5e6d7c8a";
  const popup = await renderPopup({
    ok: true,
    mode: "Native",
    fixture: null,
    protection: "LAST_KNOWN_GOOD",
    source: {
      hostName: "com.vpnroute.browser",
      protocolVersion: 1,
      transport: "AVAILABLE",
      service: "AVAILABLE",
      state: "AVAILABLE",
      browserProxy: "UNAVAILABLE",
      lastFetch: {
        result: "OK", at: "t", errorCode: null, hostErrorCode: null, identity: { stateGeneration: genB, revision: 1 },
        stats: { attempts: 1, messages: 3, pages: 2, largestPageBytes: 524288, totalBytes: 600000 }
      },
      fetchedIdentity: { stateGeneration: genB, revision: 1 },
      lastTransportError: null,
      lastDecision: { kind: "browser_proxy_unavailable", at: "t", message: "state 4c1d8e2f/1 not applied (new lineage)" },
      lastLineageChange: { from: genA, to: genB, at: "t2" },
      lineage: { currentGeneration: genB, acceptedRevision: 1, appliedIdentity: { stateGeneration: genA, revision: 43 }, retiredGenerations: [genA] }
    },
    diagnostics: appliedDiagnostics
  });

  assert.equal(popup.text("native-service"), "AVAILABLE");
  assert.equal(popup.text("native-state"), "AVAILABLE");
  assert.equal(popup.text("native-browser-proxy"), "UNAVAILABLE");
  assert.equal(popup.text("native-applied-identity"), "revision 43 of previous generation 9b2f6c1e");
  assert.equal(popup.text("native-lineage-change"), "9b2f6c1e → 4c1d8e2f at t2");
  assert.equal(popup.text("native-pages"), "2 pages, largest 512.0 KiB, total 585.9 KiB, attempts 1");
  assert.match(popup.text("native-decision"), /^browser_proxy_unavailable/);
  assert.equal(popup.text("protection"), "LAST_KNOWN_GOOD");
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
