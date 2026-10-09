import { Limits } from "../../domain/browser-routing/constants.js";
import { DEFAULT_NATIVE_HOST_VERSION, EXTENSION_VERSION } from "../runtime/config.js";
import {
  IntegrationErrorCode,
  effectiveBrowserProxyReadiness,
  parseIntegrationManifest
} from "./integration-manifest.js";
import { STATE_GENERATION, createBrowserRoutingSnapshot } from "./snapshot.js";

/**
 * Fetches a BrowserRoutingSnapshot from the VPN Route native host: one getStateManifest
 * followed by getStatePage requests for the same {stateGeneration, revision}, each a single
 * chrome.runtime.sendNativeMessage call (no long-lived port, no polling).
 * A snapshot is returned only when every page arrived and the assembled state passed
 * validation; a partial snapshot is never returned. The provider never applies PAC, never
 * writes proxy settings and never stores rules.
 */

export const NATIVE_PROTOCOL_VERSION = 1;
export const DEFAULT_NATIVE_TIMEOUT_MS = 5000;
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 60000;

export const SnapshotLimits = Object.freeze({
  maxRules: Limits.maxRules,
  maxPages: 160,
  maxPageBudgetBytes: 512 * 1024,
  /** Page response bytes as re-serialized here; the host enforces the 1 MiB wire limit. */
  maxPageBytes: 512 * 1024 + 16 * 1024,
  maxSnapshotBytes: 96 * 1024 * 1024,
  maxAttempts: 2
});

export const NativeErrorCode = Object.freeze({
  HostNotFound: "host_not_found",
  AccessForbidden: "access_forbidden",
  HostExited: "host_exited",
  TransportError: "transport_error",
  Timeout: "timeout",
  MalformedResponse: "malformed_response",
  UnsupportedProtocol: "unsupported_protocol",
  RequestIdMismatch: "request_id_mismatch",
  HostError: "host_error",
  InvalidManifest: "invalid_manifest",
  InvalidPage: "invalid_page",
  LimitExceeded: "limit_exceeded",
  SnapshotUnstable: "snapshot_unstable",
  SnapshotTimeout: "snapshot_timeout",
  InvalidSnapshot: "invalid_snapshot",
  InvalidState: "invalid_state",
  InvalidEndpoint: "invalid_endpoint",
  IntegrationApiIncompatible: "integration_api_incompatible",
  ManifestInvalid: "manifest_invalid",
  ProviderException: "provider_exception"
});

export const Transport = Object.freeze({ Available: "AVAILABLE", Error: "ERROR" });
export const ServiceStatus = Object.freeze({ Available: "AVAILABLE", Unavailable: "UNAVAILABLE", Unknown: "UNKNOWN" });
export const StateStatus = Object.freeze({ Available: "AVAILABLE", Unavailable: "UNAVAILABLE", Invalid: "INVALID", Unknown: "UNKNOWN" });
export const ProxyReadiness = Object.freeze({ Ready: "READY", Unavailable: "UNAVAILABLE", Unknown: "UNKNOWN" });

const HOST_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;
const SERVICE_DOWN_CODES = new Set(["service_unavailable", "service_timeout", "service_error", "service_untrusted"]);
const STATE_DOWN_CODES = new Set(["browser_state_unavailable"]);
const PAGE_FIELDS = ["stateGeneration", "revision", "startIndex", "nextIndex", "rules"];
const MAX_TEXT = 200;
const encoder = new TextEncoder();

function clip(value) {
  const text = String(value);
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "..." : text;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isIndex(value, max) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function defaultRequestId() {
  return globalThis.crypto.randomUUID();
}

function classifyLastError(message) {
  const text = message.toLowerCase();
  if (text.includes("not found")) return NativeErrorCode.HostNotFound;
  if (text.includes("forbidden")) return NativeErrorCode.AccessForbidden;
  if (text.includes("exited")) return NativeErrorCode.HostExited;
  return NativeErrorCode.TransportError;
}

class Failure {
  constructor(code, message, transport, service, hostErrorCode, state) {
    this.code = code;
    this.message = clip(message);
    this.transport = transport;
    this.service = service;
    this.hostErrorCode = hostErrorCode || null;
    this.state = state || StateStatus.Unknown;
  }
}

/** Raised by a page fetch when the Service reports that the snapshot moved on. */
class SnapshotChanged {}

/**
 * @param {{
 *   runtime: { sendNativeMessage(host: string, message: object, callback: (response: unknown) => void): void, lastError?: { message?: string } },
 *   hostName: string,
 *   timeoutMs?: number,
 *   snapshotTimeoutMs?: number,
 *   newRequestId?: () => string,
 *   now?: () => string,
 *   clock?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   extensionVersion?: string,
 *   nativeHostVersion?: string
 * }} deps
 */
export function createNativeStateProvider(deps) {
  if (typeof deps.hostName !== "string" || !HOST_NAME.test(deps.hostName)) {
    throw new Error("Invalid native messaging host name.");
  }
  if (!deps.runtime || typeof deps.runtime.sendNativeMessage !== "function") {
    throw new Error("chrome.runtime.sendNativeMessage is not available.");
  }
  const timeoutMs = deps.timeoutMs === undefined ? DEFAULT_NATIVE_TIMEOUT_MS : deps.timeoutMs;
  const snapshotTimeoutMs = deps.snapshotTimeoutMs === undefined ? DEFAULT_SNAPSHOT_TIMEOUT_MS : deps.snapshotTimeoutMs;
  const newRequestId = deps.newRequestId || defaultRequestId;
  const now = deps.now || (() => new Date().toISOString());
  const clock = deps.clock || (() => Date.now());
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((handle) => clearTimeout(handle));
  const extensionVersion = deps.extensionVersion || EXTENSION_VERSION;
  /** When set (tests), skips ping and pins heartbeat nativeHostVersion. */
  const pinnedNativeHostVersion = deps.nativeHostVersion || null;
  let runtimeNativeHostVersion = pinnedNativeHostVersion;

  /** Per provider instance: heartbeat bootstrap is tied to this transport session. */
  const integrationSession = {
    requiresBootstrap: true,
    heartbeatEnabled: false
  };

  function resetIntegrationSession() {
    integrationSession.requiresBootstrap = true;
    integrationSession.heartbeatEnabled = false;
    if (!pinnedNativeHostVersion) runtimeNativeHostVersion = null;
  }

  function heartbeatNativeHostVersion() {
    return pinnedNativeHostVersion || runtimeNativeHostVersion || DEFAULT_NATIVE_HOST_VERSION;
  }

  function readPingResult(response) {
    if (!isPlainObject(response) || !hasExactKeys(response, ["command", "host", "protocolVersion", "hostVersion"])) {
      throw new Failure(NativeErrorCode.MalformedResponse, "Ping result is invalid.", Transport.Error, ServiceStatus.Unknown);
    }
    if (response.command !== "pong" || response.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
      throw new Failure(NativeErrorCode.MalformedResponse, "Ping result is invalid.", Transport.Error, ServiceStatus.Unknown);
    }
    const version = response.hostVersion;
    if (typeof version !== "string" || version.length === 0 || version.length > 128) {
      throw new Failure(NativeErrorCode.MalformedResponse, "Ping hostVersion is invalid.", Transport.Error, ServiceStatus.Unknown);
    }
    for (let i = 0; i < version.length; i++) {
      const c = version.charCodeAt(i);
      if (c < 32 || c > 126) {
        throw new Failure(NativeErrorCode.MalformedResponse, "Ping hostVersion is invalid.", Transport.Error, ServiceStatus.Unknown);
      }
    }
    return version;
  }

  async function ensureRuntimeNativeHostVersion() {
    if (pinnedNativeHostVersion || runtimeNativeHostVersion) return runtimeNativeHostVersion;
    const requestId = newRequestId();
    const outcome = await exchange({ protocolVersion: NATIVE_PROTOCOL_VERSION, requestId, command: "ping" });
    if (outcome.transportError) {
      throw new Failure(outcome.transportError, outcome.message, Transport.Error, ServiceStatus.Unknown);
    }
    const response = outcome.response;
    const malformed = (message) => new Failure(NativeErrorCode.MalformedResponse, message, Transport.Error, ServiceStatus.Unknown);
    if (!isPlainObject(response)) throw malformed("Ping response is not a JSON object.");
    if (response.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
      throw new Failure(NativeErrorCode.UnsupportedProtocol, "Unsupported protocolVersion in ping response.", Transport.Error, ServiceStatus.Unknown);
    }
    if (response.ok !== true) throw malformed("Ping response was not successful.");
    if (!hasExactKeys(response, ["protocolVersion", "requestId", "ok", "result"])) throw malformed("Unexpected ping envelope.");
    if (response.requestId !== requestId) {
      throw new Failure(NativeErrorCode.RequestIdMismatch, "Ping response requestId does not match.", Transport.Error, ServiceStatus.Unknown);
    }
    runtimeNativeHostVersion = readPingResult(response.result);
    return runtimeNativeHostVersion;
  }

  function exchange(request) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve(outcome);
      };
      const timer = setTimer(() => finish({ transportError: NativeErrorCode.Timeout, message: "No response within " + timeoutMs + " ms." }), timeoutMs);
      try {
        deps.runtime.sendNativeMessage(deps.hostName, request, (response) => {
          const lastError = deps.runtime.lastError;
          if (lastError) {
            const message = clip(lastError.message || "Unknown native messaging error.");
            finish({ transportError: classifyLastError(message), message });
          } else {
            finish({ response });
          }
        });
      } catch (error) {
        finish({ transportError: NativeErrorCode.TransportError, message: clip(error && error.message ? error.message : error) });
      }
    });
  }

  /**
   * Sends one request and returns the validated `result` object; throws Failure otherwise.
   */
  async function call(session, fields) {
    if (clock() > session.deadline) {
      throw new Failure(NativeErrorCode.SnapshotTimeout, "Snapshot was not complete within " + snapshotTimeoutMs + " ms.",
        Transport.Available, ServiceStatus.Unknown);
    }
    const requestId = newRequestId();
    session.requestIds.push(requestId);
    session.stats.messages++;
    const outcome = await exchange({ protocolVersion: NATIVE_PROTOCOL_VERSION, requestId, ...fields });
    if (outcome.transportError) {
      throw new Failure(outcome.transportError, outcome.message, Transport.Error, ServiceStatus.Unknown);
    }
    const response = outcome.response;
    const malformed = (message) => new Failure(NativeErrorCode.MalformedResponse, message, Transport.Error, ServiceStatus.Unknown);

    if (!isPlainObject(response)) throw malformed("Response is not a JSON object.");
    if (response.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
      throw new Failure(NativeErrorCode.UnsupportedProtocol, "Unsupported protocolVersion in response.", Transport.Error, ServiceStatus.Unknown);
    }
    if (typeof response.ok !== "boolean") throw malformed("Response has no boolean ok.");

    if (response.ok === false) {
      if (!hasExactKeys(response, ["protocolVersion", "requestId", "ok", "error"])) throw malformed("Unexpected error envelope fields.");
      const error = response.error;
      if (!isPlainObject(error) || !hasExactKeys(error, ["code", "message"]) ||
        typeof error.code !== "string" || !ERROR_CODE.test(error.code) || typeof error.message !== "string") {
        throw malformed("Error object is invalid.");
      }
      // A host that could not read the request (e.g. forbidden origin) answers with requestId null.
      if (response.requestId !== requestId && response.requestId !== null) {
        throw new Failure(NativeErrorCode.RequestIdMismatch, "Response requestId does not match.", Transport.Error, ServiceStatus.Unknown);
      }
      if (error.code === "snapshot_changed" && fields.command === "getStatePage") throw new SnapshotChanged();
      const service = SERVICE_DOWN_CODES.has(error.code)
        ? ServiceStatus.Unavailable
        : STATE_DOWN_CODES.has(error.code) ? ServiceStatus.Available : ServiceStatus.Unknown;
      const state = STATE_DOWN_CODES.has(error.code) ? StateStatus.Unavailable : StateStatus.Unknown;
      throw new Failure(NativeErrorCode.HostError, error.message, Transport.Available, service, error.code, state);
    }

    if (!hasExactKeys(response, ["protocolVersion", "requestId", "ok", "result"])) throw malformed("Unexpected success envelope fields.");
    if (response.requestId !== requestId) {
      throw new Failure(NativeErrorCode.RequestIdMismatch, "Response requestId does not match.", Transport.Error, ServiceStatus.Unknown);
    }
    return response;
  }

  function invalid(code, message) {
    return new Failure(code, message, Transport.Available, ServiceStatus.Available, null, StateStatus.Invalid);
  }

  function readManifest(result) {
    const parsed = parseIntegrationManifest(result);
    if (!parsed.ok) {
      let code = NativeErrorCode.InvalidManifest;
      if (parsed.code === IntegrationErrorCode.IntegrationApiIncompatible) code = NativeErrorCode.IntegrationApiIncompatible;
      else if (parsed.code === IntegrationErrorCode.InvalidEndpoint) code = NativeErrorCode.InvalidEndpoint;
      throw invalid(code, parsed.message);
    }
    if (result.schemaVersion !== 1) throw invalid(NativeErrorCode.InvalidManifest, "Unsupported manifest schemaVersion.");
    if (typeof result.stateGeneration !== "string" || !STATE_GENERATION.test(result.stateGeneration)) {
      throw invalid(NativeErrorCode.InvalidManifest, "Manifest stateGeneration is invalid.");
    }
    if (!isIndex(result.revision, Number.MAX_SAFE_INTEGER)) throw invalid(NativeErrorCode.InvalidManifest, "Manifest revision is invalid.");
    if (!isIndex(result.ruleCount, Number.MAX_SAFE_INTEGER)) throw invalid(NativeErrorCode.InvalidManifest, "Manifest ruleCount is invalid.");
    if (result.ruleCount > SnapshotLimits.maxRules) {
      throw invalid(NativeErrorCode.LimitExceeded, "Manifest ruleCount " + result.ruleCount + " exceeds " + SnapshotLimits.maxRules + ".");
    }
    if (!Number.isSafeInteger(result.pageBudgetBytes) || result.pageBudgetBytes < 1 || result.pageBudgetBytes > SnapshotLimits.maxPageBudgetBytes) {
      throw invalid(NativeErrorCode.InvalidManifest, "Manifest pageBudgetBytes is invalid.");
    }
    integrationSession.requiresBootstrap = false;
    integrationSession.heartbeatEnabled = parsed.integration.browserClientHeartbeat;
    return {
      ...result,
      browserProxy: parsed.browserProxy,
      integration: parsed.integration
    };
  }

  function manifestRequestFields() {
    const fields = { command: "getStateManifest" };
    if (!integrationSession.requiresBootstrap && integrationSession.heartbeatEnabled) {
      fields.client = { extensionVersion, nativeHostVersion: heartbeatNativeHostVersion() };
    }
    return fields;
  }

  function readPage(session, manifest, startIndex, response) {
    const bytes = encoder.encode(JSON.stringify(response)).length;
    session.stats.totalBytes += bytes;
    session.stats.largestPageBytes = Math.max(session.stats.largestPageBytes, bytes);
    if (bytes > SnapshotLimits.maxPageBytes) {
      throw invalid(NativeErrorCode.LimitExceeded, "Page of " + bytes + " bytes exceeds " + SnapshotLimits.maxPageBytes + ".");
    }
    if (session.stats.totalBytes > SnapshotLimits.maxSnapshotBytes) {
      throw invalid(NativeErrorCode.LimitExceeded, "Snapshot exceeds " + SnapshotLimits.maxSnapshotBytes + " bytes.");
    }
    const page = response.result;
    if (!isPlainObject(page) || !hasExactKeys(page, PAGE_FIELDS)) throw invalid(NativeErrorCode.InvalidPage, "Page fields are invalid.");
    if (page.stateGeneration !== manifest.stateGeneration || page.revision !== manifest.revision) {
      throw invalid(NativeErrorCode.InvalidPage, "Page identity differs from the manifest.");
    }
    if (page.startIndex !== startIndex) throw invalid(NativeErrorCode.InvalidPage, "Page startIndex differs from the request.");
    if (!Array.isArray(page.rules) || page.rules.length === 0) throw invalid(NativeErrorCode.InvalidPage, "Page has no rules.");
    const end = startIndex + page.rules.length;
    if (end > manifest.ruleCount) throw invalid(NativeErrorCode.InvalidPage, "Page has more rules than the manifest announced.");
    const expectedNext = end === manifest.ruleCount ? null : end;
    if (page.nextIndex !== expectedNext) throw invalid(NativeErrorCode.InvalidPage, "Page nextIndex is inconsistent.");
    return page;
  }

  async function attempt(session) {
    session.stats.attempts++;
    session.stats.pages = 0;
    session.stats.largestPageBytes = 0;
    session.stats.totalBytes = 0;

    const bootstrapManifest = integrationSession.requiresBootstrap;
    const manifestResponse = await call(session, manifestRequestFields());
    const manifest = readManifest(manifestResponse.result);
    session.manifest = manifest;
    session.integration = manifest.integration;

    if (bootstrapManifest && integrationSession.heartbeatEnabled) {
      await call(session, manifestRequestFields());
    }

    const rules = [];
    let startIndex = 0;
    while (startIndex < manifest.ruleCount) {
      if (session.stats.pages >= SnapshotLimits.maxPages) {
        throw invalid(NativeErrorCode.LimitExceeded, "Snapshot needs more than " + SnapshotLimits.maxPages + " pages.");
      }
      const response = await call(session, {
        command: "getStatePage",
        stateGeneration: manifest.stateGeneration,
        revision: manifest.revision,
        startIndex
      });
      session.stats.pages++;
      const page = readPage(session, manifest, startIndex, response);
      for (const rule of page.rules) rules.push(rule);
      startIndex = page.nextIndex === null ? manifest.ruleCount : page.nextIndex;
    }

    const checked = createBrowserRoutingSnapshot({
      identity: { stateGeneration: manifest.stateGeneration, revision: manifest.revision },
      state: { schemaVersion: manifest.schemaVersion, revision: manifest.revision, defaultRoute: manifest.defaultRoute, rules },
      browserProxy: { status: manifest.browserProxy.status, endpoint: manifest.browserProxy.endpoint }
    });
    if (!checked.ok) throw invalid(checked.error.code, checked.error.issues.join("; ") || checked.error.code);
    return checked.snapshot;
  }

  function readiness(manifest) {
    if (!manifest || !manifest.integration) return ProxyReadiness.Unknown;
    return effectiveBrowserProxyReadiness(manifest.browserProxy, manifest.integration) === "READY"
      ? ProxyReadiness.Ready
      : ProxyReadiness.Unavailable;
  }

  function identityOf(manifest) {
    return manifest ? Object.freeze({ stateGeneration: manifest.stateGeneration, revision: manifest.revision }) : null;
  }

  async function getSnapshot() {
    const session = {
      deadline: clock() + snapshotTimeoutMs,
      requestIds: [],
      manifest: null,
      stats: { attempts: 0, messages: 0, pages: 0, largestPageBytes: 0, totalBytes: 0 }
    };
    let failure = null;
    try {
      await ensureRuntimeNativeHostVersion();
      while (session.stats.attempts < SnapshotLimits.maxAttempts) {
        try {
          const snapshot = await attempt(session);
          return Object.freeze({
            ok: true,
            requestId: session.requestIds[0],
            at: now(),
            transport: Transport.Available,
            service: ServiceStatus.Available,
            state: StateStatus.Available,
            browserProxy: readiness(session.manifest),
            integration: session.integration,
            nativeHostVersion: heartbeatNativeHostVersion(),
            identity: snapshot.identity,
            stats: Object.freeze({ ...session.stats }),
            snapshot
          });
        } catch (error) {
          if (!(error instanceof SnapshotChanged)) throw error;
        }
      }
      failure = new Failure(NativeErrorCode.SnapshotUnstable,
        "Service state changed during " + SnapshotLimits.maxAttempts + " consecutive snapshot attempts.",
        Transport.Available, ServiceStatus.Available, "snapshot_changed", StateStatus.Available);
    } catch (error) {
      failure = error instanceof Failure
        ? error
        : new Failure(NativeErrorCode.ProviderException, error && error.message ? error.message : error, Transport.Error, ServiceStatus.Unknown);
    }
    if (failure.transport === Transport.Error || failure.service === ServiceStatus.Unavailable) {
      resetIntegrationSession();
    }
    if (failure.code === NativeErrorCode.IntegrationApiIncompatible ||
      failure.code === NativeErrorCode.ManifestInvalid ||
      failure.code === NativeErrorCode.InvalidManifest) {
      resetIntegrationSession();
    }
    return Object.freeze({
      ok: false,
      requestId: session.requestIds[0] || null,
      at: now(),
      transport: failure.transport,
      service: failure.service,
      state: failure.state,
      browserProxy: readiness(session.manifest),
      integration: session.integration || null,
      identity: identityOf(session.manifest),
      stats: Object.freeze({ ...session.stats }),
      error: Object.freeze({ code: failure.code, message: failure.message, hostErrorCode: failure.hostErrorCode })
    });
  }

  return Object.freeze({
    kind: "Native",
    hostName: deps.hostName,
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    getSnapshot,
    resetIntegrationSession
  });
}
