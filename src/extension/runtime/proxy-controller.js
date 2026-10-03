/**
 * PAC application lifecycle for the extension. All browser access is injected, so the
 * state machine runs unchanged in the service worker and in Node tests.
 *
 * Invariants:
 * - another extension's or a policy's proxy configuration is never overwritten;
 * - a failed compile or apply never clears the proxy and never installs DIRECT;
 * - APPLIED is reported only after set() and a read-back that shows this PAC;
 * - the proxy is cleared only by an explicit clear() call;
 * - storage holds diagnostics only, never routing rules.
 */

export const Status = Object.freeze({
  Idle: "IDLE",
  Applying: "APPLYING",
  Applied: "APPLIED",
  NotApplied: "NOT_APPLIED",
  Error: "ERROR",
  Conflict: "CONFLICT",
  NotControllable: "NOT_CONTROLLABLE",
  Unavailable: "UNAVAILABLE"
});

export const ActivePac = Object.freeze({
  Current: "CURRENT",
  Previous: "PREVIOUS",
  Unrecognized: "UNRECOGNIZED",
  None: "NONE",
  Unknown: "UNKNOWN"
});

export const Level = Object.freeze({
  Controllable: "controllable_by_this_extension",
  ControlledByThis: "controlled_by_this_extension",
  ControlledByOther: "controlled_by_other_extensions",
  NotControllable: "not_controllable"
});

const HEADER_REVISION = /^\/\/ BrowserRoutingState schemaVersion: \d+, revision: (\d+)$/m;
const MAX_TEXT = 300;

export function createInitialDiagnostics() {
  return {
    diagnosticsVersion: 1,
    status: Status.Idle,
    proxyApi: "UNKNOWN",
    levelOfControl: null,
    state: null,
    compile: { status: "NOT_RUN" },
    active: { pac: ActivePac.Unknown, revision: null, mode: null, mandatory: null, verification: null },
    lastApplied: null,
    lastOperation: null,
    lastError: null,
    lastProxyError: null
  };
}

export function canControl(levelOfControl) {
  return levelOfControl === Level.Controllable || levelOfControl === Level.ControlledByThis;
}

function normalizePac(text) {
  return text.replace(/\r\n/g, "\n").trim();
}

export function readHeaderRevision(text) {
  const match = typeof text === "string" ? HEADER_REVISION.exec(text) : null;
  return match ? Number(match[1]) : null;
}

function clip(value) {
  const text = String(value);
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "..." : text;
}

function errorText(error) {
  return clip(error && error.message ? error.message : error);
}

/**
 * Classifies what the browser reports as the effective proxy configuration.
 *
 * @param {{ levelOfControl?: string, value?: any }} details
 * @param {{ script?: string, revision: number, scriptLength?: number } | null} compiled
 *   the PAC that should be active; without `script` it is matched by header revision and length
 * @param {{ revision: number, scriptLength: number } | null} lastApplied
 */
export function classifyActive(details, compiled, lastApplied) {
  const level = details && details.levelOfControl ? details.levelOfControl : "unknown";
  const value = (details && details.value) || {};
  const pacScript = value.pacScript || {};
  const data = typeof pacScript.data === "string" ? normalizePac(pacScript.data) : null;
  const base = {
    mode: value.mode || null,
    mandatory: typeof pacScript.mandatory === "boolean" ? pacScript.mandatory : null,
    dataReturned: data !== null,
    headerRevision: data === null ? null : readHeaderRevision(data)
  };

  if (level !== Level.ControlledByThis || value.mode !== "pac_script") {
    return { pac: ActivePac.None, revision: null, verification: null, ...base };
  }
  if (pacScript.mandatory !== true) {
    return { pac: ActivePac.Unrecognized, revision: base.headerRevision, verification: "not_mandatory", ...base };
  }

  if (data !== null) {
    if (compiled && typeof compiled.script === "string" && data === normalizePac(compiled.script)) {
      return { pac: ActivePac.Current, revision: compiled.revision, verification: "data_match", ...base };
    }
    if (compiled && typeof compiled.script !== "string" &&
      base.headerRevision === compiled.revision && data.length === compiled.scriptLength) {
      return { pac: ActivePac.Current, revision: compiled.revision, verification: "header_and_length", ...base };
    }
    if (lastApplied && base.headerRevision === lastApplied.revision && data.length === lastApplied.scriptLength) {
      return { pac: ActivePac.Previous, revision: lastApplied.revision, verification: "header_and_length", ...base };
    }
    return { pac: ActivePac.Unrecognized, revision: base.headerRevision, verification: "data_mismatch", ...base };
  }

  if (lastApplied && compiled && lastApplied.revision === compiled.revision) {
    return { pac: ActivePac.Current, revision: lastApplied.revision, verification: "data_unavailable", ...base };
  }
  if (lastApplied) {
    return { pac: ActivePac.Previous, revision: lastApplied.revision, verification: "data_unavailable", ...base };
  }
  return { pac: ActivePac.Unrecognized, revision: null, verification: "data_unavailable", ...base };
}

function stateSummary(state) {
  if (!state || typeof state !== "object") return null;
  const rules = Array.isArray(state.rules) ? state.rules : [];
  return {
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    defaultRoute: state.defaultRoute,
    ruleCount: rules.length,
    enabledRuleCount: rules.filter((rule) => rule && rule.enabled === true).length
  };
}

function compileSummary(result) {
  if (result.ok) {
    const m = result.metadata;
    return {
      status: "COMPILED",
      revision: m.revision,
      byteLength: m.byteLength,
      proxyRoute: m.proxyRoute,
      endpoint: m.proxyEndpoint.host + ":" + m.proxyEndpoint.port,
      enabledRuleCount: m.enabledRuleCount,
      exactRuleCount: m.exactRuleCount,
      domainRuleCount: m.domainRuleCount
    };
  }
  return {
    status: "ERROR",
    errorCode: result.error.code,
    issueCount: result.issues.length,
    issues: result.issues.slice(0, 5).map((entry) => entry.code + " " + entry.path)
  };
}

/**
 * Two state supply modes:
 * - build-time state: `loadState` + `endpoint` are given and recompiled on demand;
 * - pushed snapshots: no `loadState`; every `apply(reason, snapshot)` carries
 *   `{ state, proxyEndpoint: { host, port } }`. Between applies (e.g. after a service
 *   worker restart) the last successful apply is the reference for CURRENT.
 *
 * @param {{
 *   proxy: { available: boolean, get(): Promise<any>, set(value: any): Promise<void>, clear(): Promise<void> },
 *   storage: { read(): Promise<any>, write(value: any): Promise<void> },
 *   loadState?: () => unknown,
 *   compile: (state: unknown, options: object) => any,
 *   endpoint?: { proxyHost: string, proxyPort: number },
 *   now?: () => string
 * }} deps
 */
export function createProxyController(deps) {
  const now = deps.now || (() => new Date().toISOString());
  let queue = Promise.resolve();
  let compiled = null;

  function serial(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function load() {
    const stored = await deps.storage.read();
    const base = createInitialDiagnostics();
    if (!stored || stored.diagnosticsVersion !== base.diagnosticsVersion) return base;
    return { ...base, ...stored };
  }

  async function save(diagnostics) {
    await deps.storage.write(diagnostics);
    return diagnostics;
  }

  function operation(kind, result, message) {
    return { kind, result, at: now(), message: message ? clip(message) : null };
  }

  const hasBuiltInState = typeof deps.loadState === "function";
  let compileAttempted = false;

  function compileCurrent(d, snapshot) {
    compileAttempted = true;
    let state;
    let result;
    try {
      let options;
      if (snapshot) {
        state = snapshot.state;
        options = { proxyHost: snapshot.proxyEndpoint.host, proxyPort: snapshot.proxyEndpoint.port };
      } else if (hasBuiltInState) {
        state = deps.loadState();
        options = { proxyHost: deps.endpoint.proxyHost, proxyPort: deps.endpoint.proxyPort };
      } else {
        throw new Error("No state snapshot was supplied.");
      }
      result = deps.compile(state, options);
    } catch (error) {
      result = { ok: false, error: { code: "compile_exception", message: errorText(error) }, issues: [] };
    }
    d.state = stateSummary(state);
    d.compile = compileSummary(result);
    compiled = result.ok ? { script: result.script, revision: result.metadata.revision, metadata: result.metadata } : null;
    return result;
  }

  function observeInto(d, details) {
    d.levelOfControl = details && details.levelOfControl ? details.levelOfControl : "unknown";
    const active = classifyActive(details, compiled || lastSuccessfulReference(d), d.lastApplied);
    d.active = {
      pac: active.pac,
      revision: active.revision,
      mode: active.mode,
      mandatory: active.mandatory,
      verification: active.verification,
      dataReturned: active.dataReturned,
      headerRevision: active.headerRevision
    };
    return active;
  }

  function lastSuccessfulReference(d) {
    if (hasBuiltInState || compileAttempted || d.status !== Status.Applied || !d.lastApplied) return null;
    return { revision: d.lastApplied.revision, scriptLength: d.lastApplied.scriptLength };
  }

  async function observe(d) {
    try {
      observeInto(d, await deps.proxy.get());
    } catch (error) {
      d.active = { ...d.active, pac: ActivePac.Unknown };
      d.lastError = { message: "proxy.settings.get failed: " + errorText(error), at: now() };
    }
  }

  function levelStatus(level) {
    if (level === Level.ControlledByOther) return Status.Conflict;
    if (level === Level.NotControllable) return Status.NotControllable;
    return null;
  }

  async function fail(d, kind, message) {
    d.status = Status.Error;
    d.lastError = { message: clip(message), at: now() };
    d.lastOperation = operation(kind, "ERROR", message);
    return save(d);
  }

  async function apply(reason, snapshot) {
    const kind = "apply:" + (reason || "manual");
    const d = await load();

    if (!deps.proxy.available) {
      d.proxyApi = "UNAVAILABLE";
      d.status = Status.Unavailable;
      d.lastOperation = operation(kind, "UNAVAILABLE", "chrome.proxy is not available.");
      return save(d);
    }
    d.proxyApi = "AVAILABLE";

    const result = compileCurrent(d, snapshot);
    if (!result.ok) {
      await observe(d);
      const protection = d.active.pac === ActivePac.Previous
        ? " Last known good PAC revision " + d.active.revision + " stays active."
        : d.active.pac === ActivePac.None
          ? " No PAC from this extension is active: routing is NOT protected."
          : "";
      return fail(d, kind, "Compile failed (" + result.error.code + "); the proxy configuration was left unchanged." + protection);
    }

    let before;
    try {
      before = await deps.proxy.get();
    } catch (error) {
      return fail(d, kind, "proxy.settings.get failed: " + errorText(error));
    }
    observeInto(d, before);

    if (!canControl(d.levelOfControl)) {
      const status = levelStatus(d.levelOfControl);
      if (!status) {
        return fail(d, kind, "Unexpected levelOfControl " + d.levelOfControl + "; PAC not applied.");
      }
      d.status = status;
      const message = status === Status.Conflict
        ? "Another extension controls the proxy; PAC not applied."
        : "Proxy settings are locked by policy or the browser; PAC not applied.";
      d.lastError = { message, at: now() };
      d.lastOperation = operation(kind, status, message);
      return save(d);
    }

    d.status = Status.Applying;
    d.lastOperation = operation(kind, "APPLYING", null);
    await save(d);

    try {
      await deps.proxy.set({ mode: "pac_script", pacScript: { data: compiled.script, mandatory: true } });
    } catch (error) {
      await observe(d);
      return fail(d, kind, "proxy.settings.set failed: " + errorText(error));
    }

    let after;
    try {
      after = await deps.proxy.get();
    } catch (error) {
      d.active = { ...d.active, pac: ActivePac.Unknown };
      return fail(d, kind, "set() returned, but read-back failed: " + errorText(error));
    }

    const readBack = classifyActive(after, compiled, null);
    const verified = readBack.verification === "data_match" ||
      (readBack.verification === "data_unavailable" && readBack.mandatory === true);
    if (!verified) {
      observeInto(d, after);
      return fail(d, kind, "Read-back does not show this PAC (" + describeMismatch(readBack) + ").");
    }

    d.lastApplied = {
      revision: compiled.revision,
      scriptLength: normalizePac(compiled.script).length,
      metadata: compiled.metadata,
      verification: readBack.verification,
      at: now()
    };
    observeInto(d, after);
    d.status = Status.Applied;
    d.lastError = null;
    d.lastOperation = operation(kind, "APPLIED", null);
    return save(d);
  }

  async function clear() {
    const d = await load();
    if (!deps.proxy.available) {
      d.proxyApi = "UNAVAILABLE";
      d.status = Status.Unavailable;
      d.lastOperation = operation("clear", "UNAVAILABLE", "chrome.proxy is not available.");
      return save(d);
    }
    d.proxyApi = "AVAILABLE";
    if (!compiled && hasBuiltInState) compileCurrent(d);

    try {
      await deps.proxy.clear();
    } catch (error) {
      await observe(d);
      return fail(d, "clear", "proxy.settings.clear failed: " + errorText(error));
    }

    let after;
    try {
      after = await deps.proxy.get();
    } catch (error) {
      return fail(d, "clear", "clear() returned, but read-back failed: " + errorText(error));
    }
    const active = observeInto(d, after);
    if (active.pac !== ActivePac.None) {
      return fail(d, "clear", "clear() returned, but this extension's PAC is still effective.");
    }

    d.lastApplied = null;
    d.status = levelStatus(d.levelOfControl) || Status.NotApplied;
    d.lastError = null;
    d.lastOperation = operation("clear", "CLEARED", null);
    return save(d);
  }

  async function refresh() {
    const d = await load();
    if (!deps.proxy.available) {
      d.proxyApi = "UNAVAILABLE";
      d.status = Status.Unavailable;
      return save(d);
    }
    d.proxyApi = "AVAILABLE";
    if (!compiled && hasBuiltInState) compileCurrent(d);

    let details;
    try {
      details = await deps.proxy.get();
    } catch (error) {
      d.lastError = { message: "proxy.settings.get failed: " + errorText(error), at: now() };
      return save(d);
    }
    const active = observeInto(d, details);

    if (d.status === Status.Error) {
      return save(d);
    }
    if (active.pac === ActivePac.Current) {
      d.status = Status.Applied;
    } else if (levelStatus(d.levelOfControl)) {
      d.status = levelStatus(d.levelOfControl);
    } else if (active.pac === ActivePac.None) {
      d.status = d.status === Status.Idle ? Status.Idle : Status.NotApplied;
    } else {
      d.status = Status.Error;
      d.lastError = { message: "The effective PAC does not match the compiled state (" + describeMismatch(active) + ").", at: now() };
    }
    return save(d);
  }

  async function recordProxyError(details) {
    const d = await load();
    d.lastProxyError = {
      fatal: Boolean(details && details.fatal),
      error: details && details.error ? clip(details.error) : "unknown",
      details: details && details.details ? clip(details.details) : null,
      at: now()
    };
    return save(d);
  }

  return Object.freeze({
    apply: (reason, snapshot) => serial(() => apply(reason, snapshot)),
    clear: () => serial(clear),
    refresh: () => serial(refresh),
    read: () => serial(load),
    recordProxyError: (details) => serial(() => recordProxyError(details))
  });
}

function describeMismatch(active) {
  if (active.pac === ActivePac.None) return "mode " + active.mode + ", not controlled by this extension";
  if (active.verification === "not_mandatory") return "mandatory is not true";
  if (active.verification === "data_mismatch") return "PAC data differs";
  return active.pac.toLowerCase();
}
