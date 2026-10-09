import { validateBrowserProxy } from "./snapshot.js";

/** Extension supports this integration API major only (not semver). */
export const SUPPORTED_INTEGRATION_API_MAJOR = 1;

export const CLIENT_VERSION_MAX_LENGTH = 128;

export const IntegrationMode = Object.freeze({
  LegacyPhase5: "LEGACY_PHASE5",
  V1: "V1"
});

export const IntegrationErrorCode = Object.freeze({
  IntegrationApiIncompatible: "integration_api_incompatible",
  ManifestInvalid: "manifest_invalid",
  InvalidEndpoint: "invalid_endpoint"
});

const PHASE5_MANIFEST_KEYS = Object.freeze([
  "schemaVersion", "stateGeneration", "revision", "defaultRoute", "ruleCount", "pageBudgetBytes", "browserProxy"
]);

const KNOWN_V1_MANIFEST_KEYS = new Set([
  ...PHASE5_MANIFEST_KEYS,
  "integrationApiVersion",
  "serviceVersion",
  "capabilities",
  "vpnEgress",
  "browserClient"
]);

const VPN_EGRESS_STATUSES = new Set(["Ready", "Unavailable"]);
const BROWSER_CLIENT_STATUSES = new Set(["NeverSeen", "RecentlySeen", "Stale"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isAsciiPrintableBounded(text, max) {
  if (typeof text !== "string" || text.length === 0 || text.length > max) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 || c > 126) return false;
  }
  return true;
}

function parseCapabilities(raw) {
  if (raw === undefined) return { ok: true, capabilities: Object.freeze([]), set: new Set() };
  if (!Array.isArray(raw)) return { ok: false, message: "capabilities must be an array." };
  const list = [];
  const seen = new Set();
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 64) {
      return { ok: false, message: "capabilities entries must be non-empty strings." };
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      list.push(entry);
    }
  }
  list.sort();
  return { ok: true, capabilities: Object.freeze(list), set: seen };
}

function parseVpnEgress(raw) {
  if (raw === undefined) {
    return {
      ok: true,
      vpnEgress: Object.freeze({ status: "Unavailable", interfaceIndex: null, interfaceName: null })
    };
  }
  if (!isPlainObject(raw) || !hasExactKeys(raw, ["status", "interfaceIndex", "interfaceName"])) {
    return { ok: false, message: "vpnEgress shape is invalid." };
  }
  if (!VPN_EGRESS_STATUSES.has(raw.status)) {
    return { ok: false, message: "vpnEgress.status is invalid." };
  }
  if (raw.status === "Unavailable") {
    if (raw.interfaceIndex !== null || raw.interfaceName !== null) {
      return { ok: false, message: "vpnEgress Unavailable requires null index and name." };
    }
    return { ok: true, vpnEgress: Object.freeze({ status: "Unavailable", interfaceIndex: null, interfaceName: null }) };
  }
  if (!Number.isSafeInteger(raw.interfaceIndex) || raw.interfaceIndex < 0) {
    return { ok: false, message: "vpnEgress.interfaceIndex is invalid." };
  }
  if (raw.interfaceName !== null && typeof raw.interfaceName !== "string") {
    return { ok: false, message: "vpnEgress.interfaceName must be string or null." };
  }
  return Object.freeze({
    ok: true,
    vpnEgress: Object.freeze({
      status: "Ready",
      interfaceIndex: raw.interfaceIndex,
      interfaceName: raw.interfaceName
    })
  });
}

function parseBrowserClient(raw) {
  if (raw === undefined) {
    return {
      ok: true,
      browserClient: Object.freeze({ status: "NeverSeen", lastSeenUtc: null })
    };
  }
  if (!isPlainObject(raw) || !hasExactKeys(raw, ["status", "lastSeenUtc"])) {
    return { ok: false, message: "browserClient shape is invalid." };
  }
  if (!BROWSER_CLIENT_STATUSES.has(raw.status)) {
    return { ok: false, message: "browserClient.status is invalid." };
  }
  if (raw.lastSeenUtc !== null && typeof raw.lastSeenUtc !== "string") {
    return { ok: false, message: "browserClient.lastSeenUtc must be string or null." };
  }
  return {
    ok: true,
    browserClient: Object.freeze({ status: raw.status, lastSeenUtc: raw.lastSeenUtc })
  };
}

/**
 * Validates Phase 5 required manifest keys and parses optional Integration API v1 fields.
 * Unknown top-level keys are ignored (additive compatibility within a major).
 *
 * @param {unknown} input raw Service manifest object
 * @returns {{ ok: true, integration: object, browserProxy: object } | { ok: false, code: string, message: string }}
 */
export function parseIntegrationManifest(input) {
  if (!isPlainObject(input)) {
    return { ok: false, code: IntegrationErrorCode.ManifestInvalid, message: "Manifest is not an object." };
  }
  for (const key of PHASE5_MANIFEST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      return { ok: false, code: IntegrationErrorCode.ManifestInvalid, message: "Manifest missing required field: " + key + "." };
    }
  }
  for (const key of Object.keys(input)) {
    if (!KNOWN_V1_MANIFEST_KEYS.has(key)) {
      continue;
    }
  }

  const proxy = validateBrowserProxy(input.browserProxy);
  if (!proxy.ok) {
    return { ok: false, code: IntegrationErrorCode.InvalidEndpoint, message: "browserProxy is invalid." };
  }

  let mode = IntegrationMode.LegacyPhase5;
  let integrationApiVersion = null;
  if (Object.prototype.hasOwnProperty.call(input, "integrationApiVersion")) {
    if (!Number.isInteger(input.integrationApiVersion)) {
      return { ok: false, code: IntegrationErrorCode.ManifestInvalid, message: "integrationApiVersion must be an integer." };
    }
    integrationApiVersion = input.integrationApiVersion;
    if (integrationApiVersion > SUPPORTED_INTEGRATION_API_MAJOR) {
      return {
        ok: false,
        code: IntegrationErrorCode.IntegrationApiIncompatible,
        message: "Service API: " + integrationApiVersion + ". Extension supports: " + SUPPORTED_INTEGRATION_API_MAJOR + "."
      };
    }
    if (integrationApiVersion !== SUPPORTED_INTEGRATION_API_MAJOR) {
      return {
        ok: false,
        code: IntegrationErrorCode.IntegrationApiIncompatible,
        message: "Service API: " + integrationApiVersion + ". Extension supports: " + SUPPORTED_INTEGRATION_API_MAJOR + "."
      };
    }
    mode = IntegrationMode.V1;
  }

  let serviceVersion = null;
  if (input.serviceVersion !== undefined) {
    if (typeof input.serviceVersion !== "string" || !isAsciiPrintableBounded(input.serviceVersion, 64)) {
      return { ok: false, code: IntegrationErrorCode.ManifestInvalid, message: "serviceVersion is invalid." };
    }
    serviceVersion = input.serviceVersion;
  } else if (mode === IntegrationMode.V1) {
    return { ok: false, code: IntegrationErrorCode.ManifestInvalid, message: "serviceVersion is required for integration API v1." };
  }

  const caps = parseCapabilities(input.capabilities);
  if (!caps.ok) return { ok: false, code: IntegrationErrorCode.ManifestInvalid, message: caps.message };
  if (mode === IntegrationMode.V1 && caps.capabilities.length === 0) {
    return { ok: false, code: IntegrationErrorCode.ManifestInvalid, message: "capabilities must be present for integration API v1." };
  }

  const egress = parseVpnEgress(input.vpnEgress);
  if (!egress.ok) return { ok: false, code: IntegrationErrorCode.ManifestInvalid, message: egress.message };

  const client = parseBrowserClient(input.browserClient);
  if (!client.ok) return { ok: false, code: IntegrationErrorCode.ManifestInvalid, message: client.message };

  const explicitSocks = mode === IntegrationMode.LegacyPhase5 || caps.set.has("browserExplicitSocks");
  const heartbeat = mode === IntegrationMode.V1 && caps.set.has("browserClientHeartbeat");

  return Object.freeze({
    ok: true,
    browserProxy: proxy.browserProxy,
    integration: Object.freeze({
      mode,
      integrationApiVersion,
      serviceVersion,
      capabilities: caps.capabilities,
      hasCapability: (name) => caps.set.has(name),
      browserExplicitSocks: explicitSocks,
      browserClientHeartbeat: heartbeat,
      vpnEgress: egress.vpnEgress,
      browserClient: client.browserClient
    })
  });
}

/**
 * @param {{ status: string, endpoint: object|null }} browserProxy
 * @param {{ browserExplicitSocks: boolean }} integration
 */
export function effectiveBrowserProxyReadiness(browserProxy, integration) {
  if (browserProxy.status !== "Ready") return "UNAVAILABLE";
  if (!integration.browserExplicitSocks) return "UNAVAILABLE";
  return "READY";
}

/**
 * Routing PAC inputs: identity + browser proxy readiness endpoint (not observability fields).
 */
/**
 * @param {object} identity
 * @param {{ status: string, endpoint?: object|null }} browserProxy
 * @param {{ blocking?: boolean }} [options]
 */
export function pacApplyFingerprint(identity, browserProxy, options = {}) {
  if (options.blocking) {
    return Object.freeze({
      stateGeneration: identity.stateGeneration,
      revision: identity.revision,
      proxyStatus: "Blocking",
      host: null,
      port: null
    });
  }
  const endpoint = browserProxy.status === "Ready" && browserProxy.endpoint
    ? { host: browserProxy.endpoint.host, port: browserProxy.endpoint.port }
    : { host: null, port: null };
  return Object.freeze({
    stateGeneration: identity.stateGeneration,
    revision: identity.revision,
    proxyStatus: browserProxy.status,
    host: endpoint.host,
    port: endpoint.port
  });
}

export function samePacApplyFingerprint(a, b) {
  return Boolean(a) && Boolean(b) &&
    a.stateGeneration === b.stateGeneration &&
    a.revision === b.revision &&
    a.proxyStatus === b.proxyStatus &&
    a.host === b.host &&
    a.port === b.port;
}

export function validateManifestClient(input) {
  if (!isPlainObject(input) || !hasExactKeys(input, ["extensionVersion", "nativeHostVersion"])) {
    return { ok: false, message: "client object is invalid." };
  }
  if (!isAsciiPrintableBounded(input.extensionVersion, CLIENT_VERSION_MAX_LENGTH) ||
    !isAsciiPrintableBounded(input.nativeHostVersion, CLIENT_VERSION_MAX_LENGTH)) {
    return { ok: false, message: "client version strings are invalid." };
  }
  return {
    ok: true,
    client: Object.freeze({
      extensionVersion: input.extensionVersion,
      nativeHostVersion: input.nativeHostVersion
    })
  };
}
