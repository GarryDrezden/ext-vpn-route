import { MatchType, RouteMode } from "../domain/browser-routing/constants.js";
import { hasOwn, isPlainObject, issue, pointer } from "../domain/browser-routing/issues.js";
import { validateBrowserRoutingState } from "../domain/browser-routing/state.js";
import { FAIL_CLOSED_BLOCKING_VR_VPN } from "./blocking.js";
import { validateProxyEndpoint } from "./endpoint.js";
import { jsStringLiteral } from "./literal.js";
import { PAC_RUNTIME_SOURCE } from "./runtime.js";

export const PAC_FORMAT_VERSION = 1;

export const CompileError = Object.freeze({
  InvalidState: "invalid_state",
  InvalidOptions: "invalid_options"
});

export const OptionIssueCode = Object.freeze({
  InvalidType: "invalid_type",
  UnknownOption: "unknown_option"
});

const OPTION_KEYS = Object.freeze(["proxyHost", "proxyPort", "failClosedBlocking"]);
const ROUTE_CODE = Object.freeze({ VPN: 1, Direct: 0 });
const SAFE_HOST = /^[a-z0-9_.-]+$/;
const ASCII = /^[\u0000-\u007F]*$/;

/**
 * Compiles a BrowserRoutingStateV1 into a standalone PAC script.
 *
 * VPN routes return only `SOCKS5 <loopback>:<port>`, never with a DIRECT fallback.
 * The output depends only on the logical state: rule order, ids, names, notes and
 * disabled rules do not change the routing part of the script.
 *
 * @param {unknown} state BrowserRoutingStateV1
 * @param {{ proxyHost?: string, proxyPort: number }} options
 * @returns {{ ok: true, script: string, metadata: object } |
 *           { ok: false, error: { code: string, message: string }, issues: object[] }}
 */
export function compilePacScript(state, options) {
  const optionCheck = validateOptions(options);
  if (!optionCheck.ok) {
    return failure(CompileError.InvalidOptions, "PAC compiler options are invalid.", optionCheck.issues);
  }

  const validated = validateBrowserRoutingState(state);
  if (!validated.ok) {
    return failure(CompileError.InvalidState,
      "Browser routing state is invalid or ambiguous; no PAC is produced.", validated.issues);
  }

  const canonical = validated.state;
  const failClosedBlocking = optionCheck.failClosedBlocking === true;
  const endpoint = optionCheck.endpoint;
  const proxyRoute = failClosedBlocking ? FAIL_CLOSED_BLOCKING_VR_VPN : "SOCKS5 " + endpoint.host + ":" + endpoint.port;

  const exact = [];
  const domain = [];
  for (const rule of canonical.rules) {
    if (!rule.enabled) continue;
    const route = rule.routeMode === RouteMode.Default ? canonical.defaultRoute : rule.routeMode;
    const table = rule.matchType === MatchType.ExactHost ? exact : domain;
    for (const host of rule.hosts) {
      table.push({ host, code: ROUTE_CODE[route], labels: host.split(".").length });
    }
  }
  exact.sort((a, b) => compareText(a.host, b.host));
  domain.sort((a, b) => b.labels - a.labels || compareText(a.host, b.host));

  const tableLines = [
    ...exact.map((entry) => routeEntry("e:", entry)),
    ...domain.map((entry) => routeEntry("d:", entry))
  ];

  const script = [
    "// VPN Route browser PAC, format " + PAC_FORMAT_VERSION + ". Generated; do not edit.",
    "// BrowserRoutingState schemaVersion: " + canonical.schemaVersion + ", revision: " + canonical.revision,
    "var VR_VPN = " + jsStringLiteral(proxyRoute) + ";",
    "var VR_DIRECT = " + jsStringLiteral("DIRECT") + ";",
    "var VR_DEFAULT = " + (canonical.defaultRoute === RouteMode.VPN ? "VR_VPN" : "VR_DIRECT") + ";",
    tableLines.length === 0 ? "var VR_ROUTES = {};" : "var VR_ROUTES = {\n" + tableLines.join(",\n") + "\n};",
    PAC_RUNTIME_SOURCE
  ].join("\n");

  if (!ASCII.test(script)) {
    throw new Error("Generated PAC must be ASCII.");
  }

  return Object.freeze({
    ok: true,
    script,
    metadata: Object.freeze({
      pacFormatVersion: PAC_FORMAT_VERSION,
      schemaVersion: canonical.schemaVersion,
      revision: canonical.revision,
      defaultRoute: canonical.defaultRoute,
      failClosedBlocking,
      proxyEndpoint: failClosedBlocking ? null : endpoint,
      proxyRoute,
      ruleCount: canonical.rules.length,
      enabledRuleCount: exact.length + domain.length,
      exactRuleCount: exact.length,
      domainRuleCount: domain.length,
      byteLength: script.length
    })
  });
}

function validateOptions(options) {
  if (!isPlainObject(options)) {
    return { ok: false, issues: [issue(OptionIssueCode.InvalidType, "", "Options must be an object.")] };
  }
  const issues = [];
  for (const key of Object.keys(options).sort()) {
    if (!OPTION_KEYS.includes(key)) {
      issues.push(issue(OptionIssueCode.UnknownOption, pointer("", key), "Unknown compiler option."));
    }
  }
  if (options.failClosedBlocking === true) {
    return {
      ok: issues.length === 0,
      failClosedBlocking: true,
      endpoint: null,
      issues: Object.freeze(issues)
    };
  }
  const endpoint = validateProxyEndpoint(
    {
      host: hasOwn(options, "proxyHost") ? options.proxyHost : undefined,
      port: options.proxyPort
    },
    { host: "/proxyHost", port: "/proxyPort" });
  issues.push(...endpoint.issues);
  return { ok: issues.length === 0, failClosedBlocking: false, endpoint: endpoint.endpoint, issues };
}

function routeEntry(prefix, entry) {
  if (!SAFE_HOST.test(entry.host)) {
    throw new Error("Canonical host contains characters that are not allowed in PAC data.");
  }
  return jsStringLiteral(prefix + entry.host) + ": " + entry.code;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function failure(code, message, issues) {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message }),
    issues: Object.freeze([...issues])
  });
}
