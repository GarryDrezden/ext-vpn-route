/**
 * Forced-local network policy. It runs before any BrowserRoutingRule and before defaultRoute:
 * a matching host is always DIRECT and never reaches the VPN proxy.
 *
 * This list documents what the PAC runtime in `runtime.js` implements; tests check both against each other.
 */
export const FORCED_LOCAL_POLICY = Object.freeze({
  hostnames: Object.freeze(["localhost"]),
  hostnameSuffixes: Object.freeze([".localhost"]),
  ipv4: Object.freeze([
    "0.0.0.0/8",
    "10.0.0.0/8",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.168.0.0/16"
  ]),
  ipv6: Object.freeze([
    "::/128",
    "::1/128",
    "fc00::/7",
    "fe80::/10"
  ]),
  ipv4MappedIpv6: "::ffff:0:0/96"
});
