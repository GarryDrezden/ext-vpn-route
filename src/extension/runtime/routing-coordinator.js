/**
 * Connects a state source with the proxy controller:
 *   provider.getSnapshot() -> validated BrowserRoutingSnapshot -> lineage policy
 *   -> browser proxy readiness -> controller.apply().
 *
 * Fail-safe invariants (Native mode):
 * - a failed or invalid fetch never clears the proxy, never installs DIRECT and never falls
 *   back to a fixture: the last applied PAC stays active (last-known-good);
 * - lineage is {stateGeneration, revision}: within one generation a lower revision is
 *   rejected (stale_snapshot); a different generation starts a new lineage and retires the
 *   previous one, so a replayed snapshot of a retired generation is rejected at any revision;
 * - when the Service reports browser proxy Ready, PAC uses that loopback endpoint;
 * - when proxy is not Ready but state requires VPN routing and there is no last-known-good
 *   SOCKS endpoint, a blocking fail-closed PAC is applied (invalid SOCKS directive, no TCP target);
 * - otherwise the current PAC is kept as is (browser_proxy_unavailable);
 * - the proxy is cleared only by an explicit clear(), which keeps the lineage.
 *
 * Fixture mode keeps the Phase 3 behaviour: every sync recompiles the build-time fixture.
 */

import { samePacApplyFingerprint, pacApplyFingerprint } from "../state/integration-manifest.js";
import { stateRequiresVpnFailClosedRouting } from "../state/vpn-routing-policy.js";
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
  RetiredGeneration: "retired_generation",
  BrowserProxyUnavailable: "browser_proxy_unavailable",
  FailClosedBlockingApplied: "fail_closed_blocking_applied",
  IntegrationApiIncompatible: "integration_api_incompatible",
  ManifestInvalid: "manifest_invalid",
  FetchFailed: "fetch_failed",
  ApplyFailed: "apply_failed",
  Cleared: "cleared",
  ClearFailed: "clear_failed"
});

export const MAX_RETIRED_GENERATIONS = 16;

const SOURCE_DIAGNOSTICS_VERSION = 3;
const TRANSPORT_ERROR_CODES = new Set([
  "host_not_found", "access_forbidden", "host_exited", "transport_error", "timeout",
  "malformed_response", "unsupported_protocol", "request_id_mismatch", "provider_exception"
]);

export function createInitialLineage() {
  return { currentGeneration: null, acceptedRevision: null, appliedIdentity: null, retiredGenerations: [] };
}

export function createInitialSourceDiagnostics(provider) {
  return {
    sourceVersion: SOURCE_DIAGNOSTICS_VERSION,
    hostName: provider.hostName,
    protocolVersion: provider.protocolVersion,
    transport: "UNKNOWN",
    service: "UNKNOWN",
    state: "UNKNOWN",
    browserProxy: "UNKNOWN",
    lastFetch: null,
    fetchedIdentity: null,
    lastTransportError: null,
    lastDecision: null,
    lastLineageChange: null,
    lineage: createInitialLineage()
  };
}

function sameIdentity(a, b) {
  return Boolean(a) && Boolean(b) && a.stateGeneration === b.stateGeneration && a.revision === b.revision;
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
  const appliedFingerprint = source && source.lineage && source.lineage.appliedPacFingerprint;
  const fetchedFingerprint = source && source.fetchedPacFingerprint;
  const current = fetchedOk && source.browserProxy === "READY" &&
    samePacApplyFingerprint(appliedFingerprint, fetchedFingerprint) &&
    source.fetchedIdentity.revision === active.revision;
  return current ? Protection.Current : Protection.LastKnownGood;
}

function sameEndpoint(lastApplied, endpoint) {
  const applied = lastApplied && lastApplied.metadata && lastApplied.metadata.proxyEndpoint;
  return Boolean(applied) && applied.host === endpoint.host && applied.port === endpoint.port;
}

function lastKnownGoodProxyEndpoint(diagnostics) {
  const metadata = diagnostics && diagnostics.lastApplied && diagnostics.lastApplied.metadata;
  if (!metadata || metadata.failClosedBlocking) return null;
  const endpoint = metadata.proxyEndpoint;
  if (!endpoint) return null;
  return { host: endpoint.host, port: endpoint.port };
}

function lastAppliedIsFailClosedBlocking(diagnostics) {
  return Boolean(diagnostics && diagnostics.lastApplied && diagnostics.lastApplied.metadata &&
    diagnostics.lastApplied.metadata.failClosedBlocking);
}

function short(generation) {
  return generation ? generation.slice(0, 8) : "none";
}

function describe(identity) {
  return short(identity.stateGeneration) + "/" + identity.revision;
}

/**
 * @param {{
 *   mode: "Fixture" | "Native",
 *   controller: { apply(reason: string, snapshot?: any): Promise<any>, clear(): Promise<any>, refresh(): Promise<any>, read(): Promise<any> },
 *   provider?: { hostName: string, protocolVersion: number, getSnapshot(): Promise<any> },
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
    return {
      ...base,
      ...stored,
      hostName: base.hostName,
      protocolVersion: base.protocolVersion,
      lineage: { ...createInitialLineage(), ...stored.lineage }
    };
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
      return await deps.provider.getSnapshot();
    } catch (error) {
      return {
        ok: false,
        requestId: null,
        at: now(),
        transport: "ERROR",
        service: "UNKNOWN",
        state: "UNKNOWN",
        browserProxy: "UNKNOWN",
        identity: null,
        stats: null,
        error: { code: "provider_exception", message: String(error && error.message ? error.message : error), hostErrorCode: null }
      };
    }
  }

  async function finish(source, diagnostics) {
    await deps.storage.write(source);
    return view(diagnostics, source);
  }

  /**
   * Applies the lineage policy to a fetched identity and advances the lineage in place when
   * the snapshot is accepted.
   * @returns {{ rejected: { kind: string, message: string } | null, newLineage: boolean }}
   */
  function admit(source, identity) {
    const lineage = source.lineage;
    if (lineage.retiredGenerations.includes(identity.stateGeneration)) {
      return {
        rejected: { kind: Decision.RetiredGeneration, message: "generation " + short(identity.stateGeneration) + " was replaced" },
        newLineage: false
      };
    }
    let newLineage = false;
    if (lineage.currentGeneration === identity.stateGeneration) {
      if (lineage.acceptedRevision !== null && identity.revision < lineage.acceptedRevision) {
        return {
          rejected: { kind: Decision.StaleSnapshot, message: "revision " + identity.revision + " < accepted " + lineage.acceptedRevision },
          newLineage: false
        };
      }
    } else if (lineage.currentGeneration !== null) {
      lineage.retiredGenerations = [lineage.currentGeneration, ...lineage.retiredGenerations].slice(0, MAX_RETIRED_GENERATIONS);
      source.lastLineageChange = { from: lineage.currentGeneration, to: identity.stateGeneration, at: now() };
      newLineage = true;
    }
    lineage.currentGeneration = identity.stateGeneration;
    lineage.acceptedRevision = identity.revision;
    return { rejected: null, newLineage };
  }

  async function syncNative(reason) {
    const source = await loadSource();
    const fetched = await fetchSnapshot();
    source.transport = fetched.transport;
    source.service = fetched.service;
    source.state = fetched.state;
    source.browserProxy = fetched.browserProxy;

    if (!fetched.ok) {
      source.lastFetch = {
        result: "ERROR",
        at: fetched.at,
        requestId: fetched.requestId,
        errorCode: fetched.error.code,
        hostErrorCode: fetched.error.hostErrorCode,
        identity: fetched.identity,
        stats: fetched.stats
      };
      source.integration = fetched.integration || null;
      source.fetchedPacFingerprint = null;
      if (TRANSPORT_ERROR_CODES.has(fetched.error.code)) {
        source.lastTransportError = { code: fetched.error.code, message: fetched.error.message, at: fetched.at };
      }
      const decision = fetched.error.code === "integration_api_incompatible"
        ? Decision.IntegrationApiIncompatible
        : fetched.error.code === "manifest_invalid" || fetched.error.code === "invalid_manifest"
          ? Decision.ManifestInvalid
          : Decision.FetchFailed;
      decide(source, decision, fetched.error.hostErrorCode || fetched.error.message || fetched.error.code);
      return finish(source, await controller.refresh());
    }

    const snapshot = fetched.snapshot;
    const identity = snapshot.identity;
    source.lastFetch = {
      result: "OK",
      at: fetched.at,
      requestId: fetched.requestId,
      errorCode: null,
      hostErrorCode: null,
      identity,
      stats: fetched.stats
    };
    source.fetchedIdentity = identity;
    source.integration = fetched.integration || null;
    source.fetchedPacFingerprint = pacApplyFingerprint(identity, snapshot.browserProxy);

    const admission = admit(source, identity);
    if (admission.rejected) {
      decide(source, admission.rejected.kind, admission.rejected.message);
      return finish(source, await controller.refresh());
    }
    const lineageNote = admission.newLineage ? " (new lineage)" : "";

    const currentDiagnostics = await controller.refresh();
    const proxyReady = snapshot.browserProxy.status === "Ready";
    const endpoint = proxyReady ? snapshot.browserProxy.endpoint : null;
    const needsFailClosed = stateRequiresVpnFailClosedRouting(snapshot.state);
    const lkgEndpoint = lastKnownGoodProxyEndpoint(currentDiagnostics);

    if (!proxyReady) {
      source.fetchedPacFingerprint = needsFailClosed && !lkgEndpoint
        ? pacApplyFingerprint(identity, snapshot.browserProxy, { blocking: true })
        : pacApplyFingerprint(identity, snapshot.browserProxy);

      if (needsFailClosed && !lkgEndpoint) {
        const appliedFingerprint = source.lineage.appliedPacFingerprint;
        if (samePacApplyFingerprint(appliedFingerprint, source.fetchedPacFingerprint)) {
          if (currentDiagnostics.status === Status.Applied && currentDiagnostics.active.pac === ActivePac.Current &&
            currentDiagnostics.active.revision === identity.revision &&
            lastAppliedIsFailClosedBlocking(currentDiagnostics)) {
            decide(source, Decision.Unchanged, describe(identity) + " blocking");
            return finish(source, currentDiagnostics);
          }
        }
        const diagnostics = await controller.apply(reason, {
          state: snapshot.state,
          failClosedBlocking: true
        });
        if (diagnostics.status === Status.Applied && diagnostics.lastApplied &&
          diagnostics.lastApplied.revision === identity.revision) {
          source.lineage.appliedIdentity = { stateGeneration: identity.stateGeneration, revision: identity.revision };
          source.lineage.appliedPacFingerprint = source.fetchedPacFingerprint;
          decide(source, Decision.FailClosedBlockingApplied, describe(identity) + lineageNote);
        } else {
          decide(source, Decision.ApplyFailed, diagnostics.status);
        }
        return finish(source, diagnostics);
      }

      decide(source, Decision.BrowserProxyUnavailable, "state " + describe(identity) + " not applied" + lineageNote);
      return finish(source, currentDiagnostics);
    }

    source.fetchedPacFingerprint = pacApplyFingerprint(identity, snapshot.browserProxy);

    const appliedFingerprint = source.lineage.appliedPacFingerprint;
    if (samePacApplyFingerprint(appliedFingerprint, source.fetchedPacFingerprint)) {
      const stillActive = currentDiagnostics.status === Status.Applied && currentDiagnostics.active.pac === ActivePac.Current &&
        currentDiagnostics.active.revision === identity.revision && sameEndpoint(currentDiagnostics.lastApplied, endpoint);
      if (stillActive) {
        decide(source, Decision.Unchanged, describe(identity));
        return finish(source, currentDiagnostics);
      }
    }

    const diagnostics = await controller.apply(reason, { state: snapshot.state, proxyEndpoint: endpoint });
    if (diagnostics.status === Status.Applied && diagnostics.lastApplied && diagnostics.lastApplied.revision === identity.revision) {
      source.lineage.appliedIdentity = { stateGeneration: identity.stateGeneration, revision: identity.revision };
      source.lineage.appliedPacFingerprint = pacApplyFingerprint(identity, snapshot.browserProxy);
      decide(source, Decision.Applied, describe(identity) + lineageNote);
    } else {
      decide(source, Decision.ApplyFailed, diagnostics.status);
    }
    return finish(source, diagnostics);
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
      // Clearing removes the PAC, not the lineage: replays stay rejected after a clear.
      source.lineage.appliedIdentity = null;
      decide(source, Decision.Cleared, null);
    } else {
      decide(source, Decision.ClearFailed, diagnostics.status);
    }
    return finish(source, diagnostics);
  }

  return Object.freeze({
    mode,
    sync: (reason) => serial(() => (mode === StateSource.Native ? syncNative(reason) : syncFixture(reason))),
    status: () => serial(status),
    clear: () => serial(clear)
  });
}
