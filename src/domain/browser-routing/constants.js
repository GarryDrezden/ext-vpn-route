export const SCHEMA_VERSION = 1;

export const MatchType = Object.freeze({
  ExactHost: "ExactHost",
  DomainAndSubdomains: "DomainAndSubdomains"
});

export const RouteMode = Object.freeze({
  Default: "Default",
  VPN: "VPN",
  Direct: "Direct"
});

export const EffectiveRoute = Object.freeze({
  VPN: "VPN",
  Direct: "Direct"
});

export const RuleSource = Object.freeze({
  User: "User",
  System: "System"
});

export const MatchReason = Object.freeze({
  ExactRule: "exact_rule",
  DomainRule: "domain_rule",
  ExplicitDefault: "explicit_default",
  BrowserDefault: "browser_default"
});

export const Limits = Object.freeze({
  maxHostInputLength: 1024,
  maxHostLength: 253,
  maxLabelLength: 63,
  maxIdLength: 64,
  maxNameLength: 120,
  maxNotesLength: 1000,
  maxRules: 10000
});

export const MATCH_TYPES = Object.freeze(Object.values(MatchType));
export const ROUTE_MODES = Object.freeze(Object.values(RouteMode));
export const DEFAULT_ROUTES = Object.freeze(Object.values(EffectiveRoute));
export const RULE_SOURCES = Object.freeze(Object.values(RuleSource));
