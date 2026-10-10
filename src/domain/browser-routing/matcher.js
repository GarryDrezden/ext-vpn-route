import { MatchReason, MatchType, RouteMode } from "./constants.js";
import { normalizeHost } from "./host.js";
import { validateBrowserRoutingState } from "./state.js";

export const MatchError = Object.freeze({
  InvalidState: "invalid_state",
  InvalidHost: "invalid_host"
});

/**
 * Validates a state once and returns a reusable matcher over its canonical copy.
 * An invalid or ambiguous state yields no matcher at all.
 *
 * @param {unknown} state
 */
export function compileBrowserRoutingState(state) {
  const validated = validateBrowserRoutingState(state);
  if (!validated.ok) {
    return Object.freeze({ ok: false, state: null, issues: validated.issues });
  }

  const canonical = validated.state;
  const exact = new Map();
  const domain = new Map();
  for (const rule of canonical.rules) {
    if (!rule.enabled) continue;
    const table = rule.matchType === MatchType.ExactHost ? exact : domain;
    for (const host of rule.hosts) {
      table.set(host, rule);
    }
  }

  return Object.freeze({
    ok: true,
    state: canonical,
    issues: validated.issues,
    match: (host) => matchCompiled(canonical, exact, domain, host)
  });
}

/**
 * Resolves the effective browser route for a host.
 *
 * Precedence: ExactHost rule, then the DomainAndSubdomains rule with the most labels, then defaultRoute.
 * A matched rule with routeMode Default stops the search and uses defaultRoute.
 *
 * Never returns an effectiveRoute for an invalid state or host; check `ok` first.
 *
 * @param {unknown} state BrowserRoutingStateV1
 * @param {unknown} host
 */
export function matchBrowserRoute(state, host) {
  const compiled = compileBrowserRoutingState(state);
  if (!compiled.ok) {
    return Object.freeze({
      ok: false,
      inputHost: typeof host === "string" ? host : null,
      error: Object.freeze({
        code: MatchError.InvalidState,
        message: "Browser routing state is invalid or ambiguous; no route is resolved."
      }),
      issues: compiled.issues
    });
  }

  return compiled.match(host);
}

function matchCompiled(state, exact, domain, host) {
  const inputHost = typeof host === "string" ? host : null;
  const normalized = normalizeHost(host);
  if (!normalized.ok) {
    return Object.freeze({
      ok: false,
      inputHost,
      error: Object.freeze({
        code: MatchError.InvalidHost,
        hostError: normalized.error.code,
        message: normalized.error.message
      }),
      issues: Object.freeze([])
    });
  }

  const normalizedHost = normalized.host;
  let rule = exact.get(normalizedHost);
  let matchedPatternHost = rule ? normalizedHost : null;
  if (!rule) {
    const labels = normalizedHost.split(".");
    for (let start = 0; start < labels.length && !rule; start++) {
      const suffix = labels.slice(start).join(".");
      rule = domain.get(suffix);
      if (rule) matchedPatternHost = suffix;
    }
  }

  if (!rule) {
    return Object.freeze({
      ok: true,
      stateRevision: state.revision,
      inputHost,
      normalizedHost,
      matched: false,
      matchedRuleId: null,
      matchedRuleName: null,
      matchedRuleHost: null,
      matchType: null,
      ruleRouteMode: null,
      effectiveRoute: state.defaultRoute,
      reason: MatchReason.BrowserDefault
    });
  }

  const isDefault = rule.routeMode === RouteMode.Default;
  return Object.freeze({
    ok: true,
    stateRevision: state.revision,
    inputHost,
    normalizedHost,
    matched: true,
    matchedRuleId: rule.id,
    matchedRuleName: rule.name,
    matchedRuleHost: matchedPatternHost,
    matchType: rule.matchType,
    ruleRouteMode: rule.routeMode,
    effectiveRoute: isDefault ? state.defaultRoute : rule.routeMode,
    reason: isDefault
      ? MatchReason.ExplicitDefault
      : rule.matchType === MatchType.ExactHost ? MatchReason.ExactRule : MatchReason.DomainRule
  });
}
