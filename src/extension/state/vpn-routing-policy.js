import { RouteMode } from "../../domain/browser-routing/constants.js";

/**
 * True when authoritative state can send any browser hostname to VPN routing
 * (explicit VPN rules or defaultRoute VPN).
 *
 * @param {{ defaultRoute: string, rules: Array<{ enabled: boolean, routeMode: string }> }} state
 */
export function stateRequiresVpnFailClosedRouting(state) {
  if (!state || typeof state !== "object") return false;
  if (state.defaultRoute === RouteMode.VPN) return true;
  const rules = Array.isArray(state.rules) ? state.rules : [];
  for (const rule of rules) {
    if (!rule || rule.enabled !== true) continue;
    const route = rule.routeMode === RouteMode.Default ? state.defaultRoute : rule.routeMode;
    if (route === RouteMode.VPN) return true;
  }
  return false;
}
