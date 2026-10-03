import { createBrowserRoutingSnapshot } from "./snapshot.js";

/**
 * Fetches BrowserRoutingSnapshot from the VPN Route native host with one
 * chrome.runtime.sendNativeMessage call per request (no long-lived port, no polling).
 * It only reads and validates state: it never applies PAC, writes proxy settings or stores rules.
 */

export const NATIVE_PROTOCOL_VERSION = 1;
export const DEFAULT_NATIVE_TIMEOUT_MS = 5000;

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
  InvalidSnapshot: "invalid_snapshot",
  InvalidState: "invalid_state",
  InvalidEndpoint: "invalid_endpoint",
  ProviderException: "provider_exception"
});

export const Transport = Object.freeze({ Available: "AVAILABLE", Error: "ERROR" });
export const ServiceStatus = Object.freeze({ Available: "AVAILABLE", Unavailable: "UNAVAILABLE", Unknown: "UNKNOWN" });

const HOST_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;
const SERVICE_DOWN_CODES = new Set(["service_unavailable", "service_timeout", "service_error"]);
const MAX_TEXT = 200;

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

/**
 * @param {{
 *   runtime: { sendNativeMessage(host: string, message: object, callback: (response: unknown) => void): void, lastError?: { message?: string } },
 *   hostName: string,
 *   timeoutMs?: number,
 *   newRequestId?: () => string,
 *   now?: () => string,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void
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
  const newRequestId = deps.newRequestId || defaultRequestId;
  const now = deps.now || (() => new Date().toISOString());
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((handle) => clearTimeout(handle));

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

  function fail(requestId, code, message, transport, service, hostErrorCode) {
    return Object.freeze({
      ok: false,
      requestId,
      at: now(),
      transport,
      service,
      error: Object.freeze({ code, message: clip(message), hostErrorCode: hostErrorCode || null })
    });
  }

  function interpret(requestId, response) {
    const malformed = (message) =>
      fail(requestId, NativeErrorCode.MalformedResponse, message, Transport.Error, ServiceStatus.Unknown);

    if (!isPlainObject(response)) return malformed("Response is not a JSON object.");
    if (response.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
      return fail(requestId, NativeErrorCode.UnsupportedProtocol, "Unsupported protocolVersion in response.",
        Transport.Error, ServiceStatus.Unknown);
    }
    if (typeof response.ok !== "boolean") return malformed("Response has no boolean ok.");

    if (response.ok === false) {
      if (!hasExactKeys(response, ["protocolVersion", "requestId", "ok", "error"])) return malformed("Unexpected error envelope fields.");
      const error = response.error;
      if (!isPlainObject(error) || !hasExactKeys(error, ["code", "message"]) ||
        typeof error.code !== "string" || !ERROR_CODE.test(error.code) || typeof error.message !== "string") {
        return malformed("Error object is invalid.");
      }
      // A host that could not read the request (e.g. forbidden origin) answers with requestId null.
      if (response.requestId !== requestId && response.requestId !== null) {
        return fail(requestId, NativeErrorCode.RequestIdMismatch, "Response requestId does not match.", Transport.Error, ServiceStatus.Unknown);
      }
      const service = SERVICE_DOWN_CODES.has(error.code) ? ServiceStatus.Unavailable : ServiceStatus.Unknown;
      return fail(requestId, NativeErrorCode.HostError, error.message, Transport.Available, service, error.code);
    }

    if (!hasExactKeys(response, ["protocolVersion", "requestId", "ok", "result"])) return malformed("Unexpected success envelope fields.");
    if (response.requestId !== requestId) {
      return fail(requestId, NativeErrorCode.RequestIdMismatch, "Response requestId does not match.", Transport.Error, ServiceStatus.Unknown);
    }

    const checked = createBrowserRoutingSnapshot(response.result);
    if (!checked.ok) {
      return fail(requestId, checked.error.code, checked.error.issues.join("; ") || checked.error.code,
        Transport.Available, ServiceStatus.Available);
    }
    return Object.freeze({
      ok: true,
      requestId,
      at: now(),
      transport: Transport.Available,
      service: ServiceStatus.Available,
      snapshot: checked.snapshot
    });
  }

  async function getState() {
    const requestId = newRequestId();
    const request = { protocolVersion: NATIVE_PROTOCOL_VERSION, requestId, command: "getState" };
    const outcome = await exchange(request);
    if (outcome.transportError) {
      return fail(requestId, outcome.transportError, outcome.message, Transport.Error, ServiceStatus.Unknown);
    }
    return interpret(requestId, outcome.response);
  }

  return Object.freeze({
    kind: "Native",
    hostName: deps.hostName,
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    getState
  });
}
