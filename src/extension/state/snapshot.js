import { validateBrowserRoutingState } from "../../domain/browser-routing/index.js";
import { validateProxyEndpoint } from "../../pac/endpoint.js";

/**
 * BrowserRoutingSnapshot = {
 *   identity: { stateGeneration, revision },
 *   state: BrowserRoutingStateV1,
 *   browserProxy: { status: "Ready", endpoint: { host, port } } | { status: "Unavailable", endpoint: null }
 * }.
 * The routing state stays a pure BrowserRoutingStateV1; lineage and proxy readiness live
 * next to it, never inside it.
 */

export const SnapshotErrorCode = Object.freeze({
  InvalidSnapshot: "invalid_snapshot",
  InvalidState: "invalid_state",
  InvalidEndpoint: "invalid_endpoint"
});

export const BrowserProxyStatus = Object.freeze({ Ready: "Ready", Unavailable: "Unavailable" });

export const STATE_GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MAX_REPORTED_ISSUES = 5;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function failure(code, issues) {
  return Object.freeze({
    ok: false,
    snapshot: null,
    error: Object.freeze({
      code,
      issues: Object.freeze(issues.slice(0, MAX_REPORTED_ISSUES).map((entry) => entry.code + " " + entry.path))
    })
  });
}

/**
 * Validates `{ status, endpoint }` proxy readiness. Ready requires a loopback endpoint,
 * Unavailable requires endpoint null.
 *
 * @param {unknown} input
 * @param {string} path
 */
export function validateBrowserProxy(input, path = "/browserProxy") {
  if (!isPlainObject(input) || !hasExactKeys(input, ["status", "endpoint"])) {
    return { ok: false, issues: [{ code: "invalid_shape", path }] };
  }
  if (input.status === BrowserProxyStatus.Unavailable) {
    return input.endpoint === null
      ? { ok: true, browserProxy: Object.freeze({ status: BrowserProxyStatus.Unavailable, endpoint: null }) }
      : { ok: false, issues: [{ code: "unexpected_endpoint", path: path + "/endpoint" }] };
  }
  if (input.status !== BrowserProxyStatus.Ready) {
    return { ok: false, issues: [{ code: "invalid_status", path: path + "/status" }] };
  }
  if (!isPlainObject(input.endpoint) || !hasExactKeys(input.endpoint, ["host", "port"])) {
    return { ok: false, issues: [{ code: "invalid_shape", path: path + "/endpoint" }] };
  }
  const endpoint = validateProxyEndpoint(input.endpoint, { host: path + "/endpoint/host", port: path + "/endpoint/port" });
  if (!endpoint.ok) return { ok: false, issues: endpoint.issues };
  return { ok: true, browserProxy: Object.freeze({ status: BrowserProxyStatus.Ready, endpoint: endpoint.endpoint }) };
}

/**
 * Validates untrusted snapshot input and returns a frozen canonical snapshot.
 *
 * @param {unknown} input
 */
export function createBrowserRoutingSnapshot(input) {
  if (!isPlainObject(input) || !hasExactKeys(input, ["identity", "state", "browserProxy"])) {
    return failure(SnapshotErrorCode.InvalidSnapshot, [{ code: "invalid_shape", path: "" }]);
  }

  const identity = input.identity;
  if (!isPlainObject(identity) || !hasExactKeys(identity, ["stateGeneration", "revision"])) {
    return failure(SnapshotErrorCode.InvalidSnapshot, [{ code: "invalid_shape", path: "/identity" }]);
  }
  if (typeof identity.stateGeneration !== "string" || !STATE_GENERATION.test(identity.stateGeneration)) {
    return failure(SnapshotErrorCode.InvalidSnapshot, [{ code: "invalid_state_generation", path: "/identity/stateGeneration" }]);
  }

  const proxy = validateBrowserProxy(input.browserProxy);
  if (!proxy.ok) return failure(SnapshotErrorCode.InvalidEndpoint, proxy.issues);

  const state = validateBrowserRoutingState(input.state);
  if (!state.ok) return failure(SnapshotErrorCode.InvalidState, state.issues);
  if (identity.revision !== state.state.revision) {
    return failure(SnapshotErrorCode.InvalidSnapshot, [{ code: "revision_mismatch", path: "/identity/revision" }]);
  }

  return Object.freeze({
    ok: true,
    snapshot: Object.freeze({
      identity: Object.freeze({ stateGeneration: identity.stateGeneration, revision: state.state.revision }),
      state: state.state,
      browserProxy: proxy.browserProxy
    }),
    error: null
  });
}
