import { issue } from "../domain/browser-routing/issues.js";

export const DEFAULT_PROXY_HOST = "127.0.0.1";

export const EndpointIssueCode = Object.freeze({
  InvalidProxyHost: "invalid_proxy_host",
  InvalidProxyPort: "invalid_proxy_port"
});

const OCTET = /^(?:0|[1-9][0-9]{0,2})$/;

/**
 * Accepts only a dotted-quad IPv4 loopback address (127.0.0.0/8) without leading zeros.
 * Hostnames such as `localhost` are rejected: their resolution is outside the compiler's control.
 *
 * @param {unknown} host
 */
export function isLoopbackProxyHost(host) {
  if (typeof host !== "string") return false;
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!OCTET.test(part) || Number(part) > 255) return false;
  }
  return parts[0] === "127";
}

/**
 * Validates the browser proxy endpoint that VPN routes are sent to.
 *
 * @param {{ host?: unknown, port?: unknown }} input
 * @param {{ host: string, port: string }} paths JSON Pointers used in issues.
 */
export function validateProxyEndpoint(input, paths = { host: "/host", port: "/port" }) {
  const issues = [];
  const host = input.host === undefined ? DEFAULT_PROXY_HOST : input.host;

  if (!isLoopbackProxyHost(host)) {
    issues.push(issue(EndpointIssueCode.InvalidProxyHost, paths.host,
      "Proxy host must be an IPv4 loopback address such as 127.0.0.1."));
  }
  if (!(Number.isInteger(input.port) && input.port >= 1 && input.port <= 65535)) {
    issues.push(issue(EndpointIssueCode.InvalidProxyPort, paths.port,
      "Proxy port must be an integer from 1 to 65535."));
  }

  return Object.freeze({
    ok: issues.length === 0,
    endpoint: issues.length === 0 ? Object.freeze({ host, port: input.port }) : null,
    issues: Object.freeze(issues)
  });
}
