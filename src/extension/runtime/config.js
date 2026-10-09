// Phase 3 diagnostic endpoint: the Phase 0 SOCKS5 logger. Fixture builds only; Native builds take the endpoint from the Service snapshot.
export const PHASE3_PROXY_ENDPOINT = Object.freeze({ proxyHost: "127.0.0.1", proxyPort: 17891 });

export const DIAGNOSTICS_STORAGE_KEY = "vpnRouteDiagnostics";
export const SOURCE_STORAGE_KEY = "vpnRouteStateSource";

export const NATIVE_HOST_NAME = "com.vpnroute.browser";

/** MV3 periodic state refresh alarm; discovers endpoint/revision changes while the browser stays open. */
export const REFRESH_ALARM_NAME = "vpnRouteStateRefresh";
export const REFRESH_ALARM_PERIOD_MINUTES = 1;

/** Matches src/extension/manifest.json version; used for integration heartbeat only. */
/** Fallback when manifest version is unavailable (tests); Native build uses runtime.getManifest().version. */
export const EXTENSION_VERSION = "0.4.0";

/** Placeholder only when ping has not run yet; production heartbeat uses ping hostVersion. */
export const DEFAULT_NATIVE_HOST_VERSION = "0.0.0";

export { FAIL_CLOSED_BLOCKING_VR_VPN } from "../../pac/blocking.js";
