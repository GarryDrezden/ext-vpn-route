const byId = (id) => document.getElementById(id);
const buttons = ["reapply", "clear", "refresh"].map(byId);

function show(id, value, tone) {
  const element = byId(id);
  element.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
  element.className = tone || "";
}

function toneFor(status) {
  if (status === "APPLIED" || status === "COMPILED" || status === "AVAILABLE" || status === "CURRENT") return "ok";
  if (status === "APPLYING" || status === "NOT_APPLIED" || status === "IDLE" || status === "PREVIOUS" ||
    status === "LAST_KNOWN_GOOD" || status === "UNKNOWN") return "warn";
  return "bad";
}

function renderNative(source) {
  byId("native-section").hidden = false;
  byId("reapply").textContent = "Refresh state & apply";
  show("native-host", source.hostName);
  show("native-transport", source.transport, toneFor(source.transport));
  show("native-protocol", source.protocolVersion);
  show("native-service", source.service, toneFor(source.service));
  show("native-state", source.state, toneFor(source.state));
  show("native-browser-proxy", source.browserProxy, source.browserProxy === "READY" ? "ok" : toneFor(source.browserProxy));
  const f = source.lastFetch;
  show("native-last-fetch", f
    ? f.result + (f.errorCode ? " (" + (f.hostErrorCode || f.errorCode) + ")" : "") + " at " + f.at
    : "never", f ? (f.result === "OK" ? "ok" : "bad") : "warn");
  const fetched = source.fetchedIdentity;
  show("native-fetched-revision", fetched ? "revision " + fetched.revision : null);
  show("native-generation", fetched ? fetched.stateGeneration : null);
  const lineage = source.lineage || {};
  const appliedIdentity = lineage.appliedIdentity;
  show("native-applied-identity", appliedIdentity
    ? "revision " + appliedIdentity.revision + (fetched && appliedIdentity.stateGeneration !== fetched.stateGeneration
      ? " of previous generation " + appliedIdentity.stateGeneration.slice(0, 8) : "")
    : "none");
  const change = source.lastLineageChange;
  show("native-lineage-change", change ? change.from.slice(0, 8) + " → " + change.to.slice(0, 8) + " at " + change.at : "none",
    change ? "warn" : "");
  const stats = f && f.stats;
  show("native-pages", stats
    ? stats.pages + " pages, largest " + (stats.largestPageBytes / 1024).toFixed(1) + " KiB, total " +
      (stats.totalBytes / 1024).toFixed(1) + " KiB, attempts " + stats.attempts
    : null);
  const decision = source.lastDecision;
  show("native-decision", decision ? decision.kind + (decision.message ? ": " + decision.message : "") : null,
    decision && (decision.kind === "applied" || decision.kind === "unchanged") ? "ok" : decision ? "warn" : "");
  const te = source.lastTransportError;
  show("native-transport-error", te ? te.code + ": " + te.message + " (" + te.at + ")" : "none", te ? "bad" : "");
}

function render(response) {
  if (!response || response.ok !== true) {
    show("status", "ERROR", "bad");
    show("last-error", response && response.error ? response.error : "No response from the service worker.", "bad");
    return;
  }

  const d = response.diagnostics;
  show("proxy-api", d.proxyApi, toneFor(d.proxyApi));
  show("level-of-control", d.levelOfControl,
    d.levelOfControl === "controlled_by_this_extension" ? "ok" : d.levelOfControl === "controllable_by_this_extension" ? "warn" : "bad");

  show("state-source", response.mode === "Fixture" ? "Fixture (" + response.fixture + ")" : response.mode);
  show("protection", response.protection, toneFor(response.protection));
  if (response.mode === "Native" && response.source) renderNative(response.source);

  show("fixture", response.fixture);
  const s = d.state || {};
  show("state-schema", s.schemaVersion);
  show("state-revision", s.revision);
  show("state-default", s.defaultRoute);
  show("state-rules", s.enabledRuleCount === undefined ? null : s.enabledRuleCount + " of " + s.ruleCount);

  const c = d.compile || {};
  show("compile-status", c.status === "ERROR" ? "ERROR: " + c.errorCode : c.status, toneFor(c.status));
  show("compile-revision", c.revision);
  show("compile-size", c.byteLength === undefined ? null : c.byteLength + " bytes (" + (c.byteLength / 1024).toFixed(1) + " KiB)");
  show("compile-endpoint", c.endpoint);

  const a = d.active || {};
  show("status", d.status, toneFor(d.status));
  let applied = null;
  if (d.status === "APPLIED") applied = a.revision;
  else if (a.revision !== null && a.revision !== undefined) {
    applied = a.revision + (a.pac === "PREVIOUS" ? " (last known good, still active)" : " (unconfirmed)");
  }
  show("applied-revision", applied, d.status === "APPLIED" ? "ok" : a.pac === "PREVIOUS" ? "warn" : "");
  show("active-pac", a.pac, toneFor(a.pac));
  show("active-mode", a.mode);
  show("active-mandatory", a.mandatory);
  show("active-verification", a.verification);

  const op = d.lastOperation;
  show("last-operation", op ? op.kind + " → " + op.result + (op.message ? ": " + op.message : "") + " (" + op.at + ")" : null);
  show("last-error", d.lastError ? d.lastError.message : "none", d.lastError ? "bad" : "");
  const pe = d.lastProxyError;
  show("last-proxy-error", pe ? (pe.fatal ? "fatal: " : "") + pe.error + (pe.details ? " | " + pe.details : "") + " (" + pe.at + ")" : "none",
    pe ? "bad" : "");
}

function send(command) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ command }, (response) => {
      const error = chrome.runtime.lastError;
      resolve(error ? { ok: false, error: error.message } : response);
    });
  });
}

async function run(command) {
  buttons.forEach((button) => { button.disabled = true; });
  try {
    render(await send(command));
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

show("extension-id", chrome.runtime.id);
byId("reapply").addEventListener("click", () => run("reapply"));
byId("clear").addEventListener("click", () => run("clear"));
byId("refresh").addEventListener("click", () => run("status"));
run("status");
