// Phase 3 diagnostic endpoint: the Phase 0 SOCKS5 logger. Fixture builds only; Native builds take the endpoint from the Service snapshot.
export const PHASE3_PROXY_ENDPOINT = Object.freeze({ proxyHost: "127.0.0.1", proxyPort: 17891 });

export const DIAGNOSTICS_STORAGE_KEY = "vpnRouteDiagnostics";
export const SOURCE_STORAGE_KEY = "vpnRouteStateSource";

export const NATIVE_HOST_NAME = "com.vpnroute.browser";
