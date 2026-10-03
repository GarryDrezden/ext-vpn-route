// Phase 3 smoke fixture. Temporary: VPN Route Service becomes the source of state later.
// `npm run build:extension:large` replaces this file in dist/ with a generated ~10000-rule state.

export const FIXTURE_NAME = "normal";

export const SMOKE_STATE = {
  schemaVersion: 1,
  revision: 3001,
  defaultRoute: "Direct",
  rules: [
    {
      id: "youtube",
      name: "YouTube",
      host: "youtube.com",
      matchType: "DomainAndSubdomains",
      routeMode: "VPN",
      enabled: true,
      source: "User",
      notes: null
    },
    {
      id: "googlevideo",
      name: "YouTube video",
      host: "googlevideo.com",
      matchType: "DomainAndSubdomains",
      routeMode: "VPN",
      enabled: true,
      source: "User",
      notes: null
    },
    {
      id: "example",
      name: "Example",
      host: "example.com",
      matchType: "ExactHost",
      routeMode: "Direct",
      enabled: true,
      source: "User",
      notes: null
    }
  ]
};
