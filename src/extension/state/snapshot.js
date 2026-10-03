import { validateBrowserRoutingState } from "../../domain/browser-routing/index.js";
import { validateProxyEndpoint } from "../../pac/endpoint.js";

/**
 * BrowserRoutingSnapshot = { state: BrowserRoutingStateV1, proxyEndpoint: { host, port } }.
 * The routing state stays a pure BrowserRoutingStateV1; transport and Service metadata live
 * next to it, never inside it.
 */

export const SnapshotErrorCode = Object.freeze({
  InvalidSnapshot: "invalid_snapshot",
  InvalidState: "invalid_state",
  InvalidEndpoint: "invalid_endpoint"
});

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
 * Validates untrusted snapshot input and returns a frozen canonical snapshot.
 *
 * @param {unknown} input
 */
export function createBrowserRoutingSnapshot(input) {
  if (!isPlainObject(input) || !hasExactKeys(input, ["state", "proxyEndpoint"])) {
    return failure(SnapshotErrorCode.InvalidSnapshot, [{ code: "invalid_shape", path: "" }]);
  }

  const endpointInput = input.proxyEndpoint;
  if (!isPlainObject(endpointInput) || !hasExactKeys(endpointInput, ["host", "port"])) {
    return failure(SnapshotErrorCode.InvalidEndpoint, [{ code: "invalid_shape", path: "/proxyEndpoint" }]);
  }
  const endpoint = validateProxyEndpoint(endpointInput, { host: "/proxyEndpoint/host", port: "/proxyEndpoint/port" });
  if (!endpoint.ok) return failure(SnapshotErrorCode.InvalidEndpoint, endpoint.issues);

  const state = validateBrowserRoutingState(input.state);
  if (!state.ok) return failure(SnapshotErrorCode.InvalidState, state.issues);

  return Object.freeze({
    ok: true,
    snapshot: Object.freeze({ state: state.state, proxyEndpoint: endpoint.endpoint }),
    error: null
  });
}
