import { MatchType, RouteMode } from "../../domain/browser-routing/constants.js";

/** @param {{ hosts?: string[], host?: string }} rule */
export function formatRuleHostsLabel(rule) {
  const hosts = Array.isArray(rule.hosts) && rule.hosts.length > 0
    ? rule.hosts
    : (typeof rule.host === "string" && rule.host ? [rule.host] : []);
  if (hosts.length === 0) return "";
  if (hosts.length === 1) return hosts[0];
  const extra = hosts.length - 1;
  const suffix = extra === 1 ? "домен" : extra >= 2 && extra <= 4 ? "домена" : "доменов";
  return hosts[0] + " + " + extra + " " + suffix;
}

export const MATCH_TYPE_LABELS = Object.freeze({
  [MatchType.ExactHost]: "Только этот домен",
  [MatchType.DomainAndSubdomains]: "Домен и поддомены"
});

export const ROUTE_MODE_LABELS = Object.freeze({
  [RouteMode.VPN]: "Через VPN",
  [RouteMode.Direct]: "Напрямую",
  [RouteMode.Default]: "По умолчанию"
});

export function labelMatchType(value) {
  return MATCH_TYPE_LABELS[value] || value;
}

export function labelRouteMode(value) {
  return ROUTE_MODE_LABELS[value] || value;
}
