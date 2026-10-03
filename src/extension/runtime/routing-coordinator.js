/**
 * Connects a state source with the proxy controller:
 *   provider.getState() -> validated BrowserRoutingSnapshot -> revision policy -> controller.apply().
 *
 * Fail-safe invariants (Native mode):
 * - a failed or invalid fetch never clears the proxy, never installs DIRECT and never falls
 *   back to a fixture: the last applied PAC stays active (last-known-good);
 * - a snapshot older than the last applied Service revision is rejected (stale_snapshot);
 * - the proxy is cleared only by an explicit clear().
 *
 * Fixture mode keeps the Phase 3 behaviour: every sync recompiles the build-time fixture.
 */

import { ActivePac, Status } from "./proxy-controller.js";

export const StateSource = Object.freeze({ Fixture: "Fixture", Native: "Native" });

export const Protection = Object.freeze({
  Current: "CURRENT",
  LastKnownGood: "LAST_KNOWN_GOOD",
  NotProtected: "NOT_PROTECTED"
});

export const Decision = Object.freeze({
  Applied: "applied",
  Unchanged: "unchanged",
  StaleSnapshot: "stale_snapshot",
  FetchFailed: "fetch_failed",
  ApplyFailed: "apply_failed",
  Cleared: "cleared",
  ClearFailed: "clear_failed"
});

const SOURCE_DIAGNOSTICS_VERSION = 1;
const TRANSPORT_ERROR_CODES = new Set([
  "host_not_found", "access_forbidden", "host_exited", "transport_error", "timeout",
  "malformed_response", "unsupported_protocol", "request_id_mismatch", "provider_exception"
]);

export function createInitialSourceDiagnostics(provider) {
  return {
    sourceVersion: SOURCE_DIAGNOSTICS_VERSION,
    hostName: provider.hostName,
    protocolVersion: provider.protocolVersion,
    transport: "UNKNOWN",
    service: "UNKNOWN",
    lastFetch: null,
    fetchedRevision: null,
    lastTransportError: null,
    lastDecision: null,
    lineage: { lastAppliedRevision: null }
  };
}

/**
 * @param {string} mode
 * @param {any} diagnostics proxy controller diagnostics
 * @param {any} source native source diagnostics (null in Fixture mode)
 */
export function computeProtection(mode, diagnostics, source) {
  const active = diagnostics && diagnostics.active ? diagnostics.active : {};
  if (active.pac !== ActivePac.Current && active.pac !== ActivePac.Previous) return Protection.NotProtected;
  if (active.pac === ActivePac.Previous || diagnostics.status !== Status.Applied) return Protection.LastKnownGood;
  if (mode === StateSource.Fixture) return Protection.Current;
  const fetchedOk = Boolean(source && source.lastFetch && source.lastFetch.result === "OK");
  return fetchedOk && source.fetchedRevision === active.revision ? Protection.Current : Protection.LastKnownGood;
}

function sameEndpoint(lastApplied, endpoint) {
  const applied = lastApplied && lastApplied.metadata && lastApplied.metadata.proxyEndpoint;
  return Boolean(applied) && applied.host === endpoint.host && applied.port === endpoint.port;
}

/**
 * @param {{
 *   mode: "Fixture" | "Native",
 *   controller: { apply(reason: string, snapshot?: any): Promise<any>, clear(): Promise<any>, refresh(): Promise<any>, read(): Promise<any> },
 *   provider?: { hostName: string, protocolVersion: number, getState(): Promise<any> },
 *   storage?: { read(): Promise<any>, write(value: any): Promise<void> },
 *   now?: () => string
 * }} deps
 */
export function createRoutingCoordinator(deps) {
  const mode = deps.mode;
  if (mode !== StateSource.Fixture && mode !== StateSource.Native) throw new Error("Unknown state source mode.");
  if (mode === StateSource.Native && (!deps.provider || !deps.storage)) {
    throw new Error("Native mode requires a state provider and storage.");
  }
  const controller = deps.controller;
  const now = deps.now || (() => new Date().toISOString());
  let queue = Promise.resolve();

  function serial(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function loadSource() {
    const base = createInitialSourceDiagnostics(deps.provider);
    const stored = await deps.storage.read();
    if (!stored || stored.sourceVersion !== SOURCE_DIAGNOSTICS_VERSION) return base;
    return { ...base, ...stored, hostName: base.hostName, protocolVersion: base.protocolVersion };
  }

  function view(diagnostics, source) {
    return {
      mode,
      protection: computeProtection(mode, diagnostics, source),
      source,
      diagnostics
    };
  }

  function decide(source, kind, message) {
    source.lastDecision = { kind, at: now(), message: message || null };
  }

  async function syncFixture(reason) {
    const diagnostics = await controller.apply(reason);
    return view(diagnostics, null);
  }

  async function fetchSnapshot() {
    try {
      return await deps.provider.getState();
    } catch (error) {
      return {
        ok: false,
        requestId: null,
        at: now(),
        transport: "ERROR",
        service: "UNKNOWN",
        error: { code: "provider_exception", message: String(error && error.message ? error.message : error), hostErrorCode: null }
      };
    }
  }

  async function syncNative(reason) {
    const source = await loadSource();
    const fetched = await fetchSnapshot();
    source.transport = fetched.transport;
    source.service = fetched.service;

    if (!fetched.ok) {
      source.lastFetch = {
        result: "ERROR",
        at: fetched.at,
        requestId: fetched.requestId,
        errorCode: fetched.error.code,
        hostErrorCode: fetched.error.hostErrorCode
      };
      if (TRANSPORT_ERROR_CODES.has(fetched.error.code)) {
        source.lastTransportError = { code: fetched.error.code, message: fetched.error.message, at: fetched.at };
      }
      decide(source, Decision.FetchFailed, fetched.error.hostErrorCode || fetched.error.code);
      const diagnostics = await controller.refresh();
      await deps.storage.write(source);
      return view(diagnostics, source);
    }

    const snapshot = fetched.snapshot;
    const revision = snapshot.state.revision;
    source.lastFetch = { result: "OK", at: fetched.at, requestId: fetched.requestId, errorCode: null, hostErrorCode: null };
    source.fetchedRevision = revision;
    const appliedRevision = source.lineage.lastAppliedRevision;

    if (appliedRevision !== null && revision < appliedRevision) {
      decide(source, Decision.StaleSnapshot, "revision " + revision + " < applied " + appliedRevision);
      const diagnostics = await controller.refresh();
      await deps.storage.write(source);
      return view(diagnostics, source);
    }

    if (appliedRevision !== null && revision === appliedRevision) {
      const current = await controller.refresh();
      const stillActive = current.status === Status.Applied && current.active.pac === ActivePac.Current &&
        current.active.revision === revision && sameEndpoint(current.lastApplied, snapshot.proxyEndpoint);
      if (stillActive) {
        decide(source, Decision.Unchanged, "revision " + revision);
        await deps.storage.write(source);
        return view(current, source);
      }
    }

    const diagnostics = await controller.apply(reason, snapshot);
    if (diagnostics.status === Status.Applied && diagnostics.lastApplied && diagnostics.lastApplied.revision === revision) {
      source.lineage = { lastAppliedRevision: revision };
      decide(source, Decision.Applied, "revision " + revision);
    } else {
      decide(source, Decision.ApplyFailed, diagnostics.status);
    }
    await deps.storage.write(source);
    return view(diagnostics, source);
  }

  async function status() {
    const diagnostics = await controller.refresh();
    return view(diagnostics, mode === StateSource.Native ? await loadSource() : null);
  }

  async function clear() {
    const diagnostics = await controller.clear();
    if (mode === StateSource.Fixture) return view(diagnostics, null);
    const source = await loadSource();
    if (diagnostics.lastApplied === null && diagnostics.status !== Status.Error) {
      // An explicit clear starts a new lineage: the next Service snapshot is accepted at any revision.
      source.lineage = { lastAppliedRevision: null };
      decide(source, Decision.Cleared, null);
    } else {
      decide(source, Decision.ClearFailed, diagnostics.status);
    }
    await deps.storage.write(source);
    return view(diagnostics, source);
  }

  return Object.freeze({
    mode,
    sync: (reason) => serial(() => (mode === StateSource.Native ? syncNative(reason) : syncFixture(reason))),
    status: () => serial(status),
    clear: () => serial(clear)
  });
}
