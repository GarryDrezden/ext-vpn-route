import { DEFAULT_NATIVE_TIMEOUT_MS, NATIVE_PROTOCOL_VERSION } from "./native-state-provider.js";
import {
  BROWSER_ROUTING_WRITE_CAPABILITY,
  ServiceWriteErrorCode,
  WriterErrorCode,
  syncAfterBrowserRoutingWrite
} from "./browser-routing-write-contract.js";

export {
  BROWSER_ROUTING_WRITE_CAPABILITY,
  ServiceWriteErrorCode,
  WriterErrorCode,
  syncAfterBrowserRoutingWrite
};

const SERVICE_WRITE_ERRORS = new Set(Object.values(ServiceWriteErrorCode));
const SERVICE_DOWN_CODES = new Set(["service_unavailable", "service_timeout", "service_error", "service_untrusted"]);
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;
const WRITE_RESULT_FIELDS = ["stateGeneration", "revision", "defaultRoute", "ruleCount"];

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

function classifyTransport(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("not found")) return WriterErrorCode.TransportUnavailable;
  if (text.includes("forbidden")) return WriterErrorCode.TransportUnavailable;
  return WriterErrorCode.TransportUnavailable;
}

function parseWriteResult(result) {
  if (!isPlainObject(result) || !hasExactKeys(result, WRITE_RESULT_FIELDS)) {
    return { ok: false, error: { code: WriterErrorCode.MalformedResponse, message: "Write result shape is invalid." } };
  }
  if (typeof result.stateGeneration !== "string" || typeof result.defaultRoute !== "string" ||
    !Number.isSafeInteger(result.revision) || !Number.isSafeInteger(result.ruleCount)) {
    return { ok: false, error: { code: WriterErrorCode.MalformedResponse, message: "Write result fields are invalid." } };
  }
  return {
    ok: true,
    result: Object.freeze({
      stateGeneration: result.stateGeneration,
      revision: result.revision,
      defaultRoute: result.defaultRoute,
      ruleCount: result.ruleCount
    })
  };
}

function parseHostFailure(error) {
  const extra = {};
  if (Number.isSafeInteger(error.currentRevision)) extra.currentRevision = error.currentRevision;
  if (SERVICE_WRITE_ERRORS.has(error.code)) {
    return Object.freeze({
      ok: false,
      error: Object.freeze({ code: error.code, message: error.message, ...extra })
    });
  }
  if (SERVICE_DOWN_CODES.has(error.code)) {
    return Object.freeze({
      ok: false,
      error: Object.freeze({ code: WriterErrorCode.HostError, message: error.message, hostErrorCode: error.code })
    });
  }
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: WriterErrorCode.HostError, message: error.message, hostErrorCode: error.code })
  });
}

/**
 * Typed Browser Routing write client (Native Host bridge only; Service remains authoritative).
 */
export function createBrowserRoutingWriter(deps) {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS;
  const newRequestId = deps.newRequestId ?? defaultRequestId;
  const now = deps.now ?? (() => new Date().toISOString());

  function exchange(message) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      deps.runtime.sendNativeMessage(deps.hostName, message, (response) => {
        clearTimeout(timer);
        const lastError = deps.runtime.lastError;
        if (lastError && lastError.message) {
          resolve({ transportError: classifyTransport(lastError.message), message: lastError.message });
          return;
        }
        resolve({ response });
      });
    });
  }

  async function invoke(fields, integration) {
    if (!integration || typeof integration.hasCapability !== "function" ||
      !integration.hasCapability(BROWSER_ROUTING_WRITE_CAPABILITY)) {
      return Object.freeze({
        ok: false,
        at: now(),
        error: Object.freeze({
          code: WriterErrorCode.UnsupportedCapability,
          message: "Integration manifest does not advertise browserRoutingWrite."
        })
      });
    }

    const requestId = newRequestId();
    const outcome = await exchange({ protocolVersion: NATIVE_PROTOCOL_VERSION, requestId, ...fields });
    if (outcome.timedOut) {
      return Object.freeze({
        ok: false,
        at: now(),
        requestId,
        error: Object.freeze({ code: WriterErrorCode.Timeout, message: "Native host did not respond in time." })
      });
    }
    if (outcome.transportError) {
      return Object.freeze({
        ok: false,
        at: now(),
        requestId,
        error: Object.freeze({
          code: outcome.transportError,
          message: outcome.message || "Native messaging failed."
        })
      });
    }

    const response = outcome.response;
    if (!isPlainObject(response) || response.protocolVersion !== NATIVE_PROTOCOL_VERSION || typeof response.ok !== "boolean") {
      return Object.freeze({
        ok: false,
        at: now(),
        requestId,
        error: Object.freeze({ code: WriterErrorCode.MalformedResponse, message: "Native response envelope is invalid." })
      });
    }
    if (response.requestId !== requestId) {
      return Object.freeze({
        ok: false,
        at: now(),
        requestId,
        error: Object.freeze({ code: WriterErrorCode.MalformedResponse, message: "Native response requestId mismatch." })
      });
    }

    if (response.ok === false) {
      const error = response.error;
      const allowedErrorKeys = ["code", "message"];
      if (Number.isSafeInteger(error && error.currentRevision)) allowedErrorKeys.push("currentRevision");
      if (!isPlainObject(error) || !hasExactKeys(error, allowedErrorKeys) ||
        typeof error.code !== "string" || !ERROR_CODE.test(error.code) || typeof error.message !== "string") {
        return Object.freeze({
          ok: false,
          at: now(),
          requestId,
          error: Object.freeze({ code: WriterErrorCode.MalformedResponse, message: "Native error object is invalid." })
        });
      }
      const failure = parseHostFailure(error);
      return Object.freeze({ ...failure, at: now(), requestId });
    }

    const parsed = parseWriteResult(response.result);
    return Object.freeze(parsed.ok
      ? { ok: true, at: now(), requestId, result: parsed.result }
      : { ok: false, at: now(), requestId, error: parsed.error });
  }

  return Object.freeze({
    upsertRule({ integration, expectedRevision, rule }) {
      return invoke({ command: "upsertRule", expectedRevision, rule }, integration);
    },
    deleteRule({ integration, expectedRevision, id }) {
      return invoke({ command: "deleteRule", expectedRevision, id }, integration);
    },
    resetRules({ integration, expectedRevision }) {
      return invoke({ command: "resetRules", expectedRevision }, integration);
    }
  });
}
