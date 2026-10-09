import { renderFixtureModule } from "./large-fixture.js";

export const SLICE8_FAILCLOSED_FIXTURE_NAME = "slice8-failclosed";
export const SLICE8_FAILCLOSED_REVISION = 8001;
export const SLICE8_FAILCLOSED_VERSION_NAME = "slice8-failclosed browser acceptance";

/** Chromium MV3 manifest.version: 1–4 dot-separated integers, each 0–65536. */
export function isChromiumManifestVersion(version) {
  if (typeof version !== "string" || version.length === 0) return false;
  const parts = version.split(".");
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every((part) => /^\d{1,5}$/.test(part) && Number(part) >= 0 && Number(part) <= 65536);
}

/** Browser acceptance: VPN host without proxy, Direct host explicit, blocking SOCKS :0. */
export function createSlice8FailClosedState() {
  return {
    schemaVersion: 1,
    revision: SLICE8_FAILCLOSED_REVISION,
    defaultRoute: "Direct",
    rules: [
      {
        id: "ipify-vpn",
        name: "api.ipify.org VPN",
        host: "api.ipify.org",
        matchType: "ExactHost",
        routeMode: "VPN",
        enabled: true,
        source: "User",
        notes: "Slice 8 fail-closed acceptance (VPN branch must not fall back to DIRECT)"
      },
      {
        id: "example-direct",
        name: "example.com Direct",
        host: "example.com",
        matchType: "ExactHost",
        routeMode: "Direct",
        enabled: true,
        source: "User",
        notes: "Slice 8 fail-closed acceptance (explicit DIRECT)"
      }
    ]
  };
}

export function renderSlice8FailClosedSmokeModule() {
  return renderFixtureModule(SLICE8_FAILCLOSED_FIXTURE_NAME, createSlice8FailClosedState());
}
