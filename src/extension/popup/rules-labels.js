import { MatchType, RouteMode } from "../../domain/browser-routing/constants.js";

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
