/**
 * Fixed ES5 part of every generated PAC. It reads only four generated globals:
 * VR_VPN, VR_DIRECT, VR_DEFAULT and VR_ROUTES.
 *
 * Decision order inside FindProxyForURL:
 *   1. host that is not plain ASCII or cannot be classified -> VR_VPN (fail closed);
 *   2. forced-local policy (localhost, private/loopback/link-local literals) -> VR_DIRECT;
 *   3. other IP literal -> VR_DEFAULT (domain rules never apply to IP literals);
 *   4. ExactHost rule, then the longest DomainAndSubdomains suffix -> rule route;
 *   5. VR_DEFAULT.
 *
 * No DNS or network helper is ever called: the decision uses only the `host` argument.
 */
export const PAC_RUNTIME_SOURCE = String.raw`var VR_HAS_OWN = Object.prototype.hasOwnProperty;
var VR_NON_ASCII = /[^\u0000-\u007f]/;
var VR_DOMAIN_HOST = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
var VR_DIGITS = /^[0-9]+$/;
var VR_OCTET = /^(0|[1-9][0-9]{0,2})$/;
var VR_HEX_GROUP = /^[0-9a-f]{1,4}$/;
var VR_IPV6_CHARS = /^[0-9a-f:.]+$/;

function FindProxyForURL(url, host) {
  if (typeof host !== "string" || VR_NON_ASCII.test(host)) {
    return VR_VPN;
  }
  var h = host.toLowerCase();
  if (h.charAt(0) === "[") {
    if (h.length < 3 || h.charAt(h.length - 1) !== "]") {
      return VR_VPN;
    }
    return vrRouteIPv6(h.substring(1, h.length - 1));
  }
  if (h.length > 1 && h.charAt(h.length - 1) === ".") {
    h = h.substring(0, h.length - 1);
  }
  if (h.indexOf(":") !== -1) {
    return vrRouteIPv6(h);
  }
  if (h.length === 0 || h.length > 253 || !VR_DOMAIN_HOST.test(h)) {
    return VR_VPN;
  }
  if (VR_DIGITS.test(h.substring(h.lastIndexOf(".") + 1))) {
    return vrRouteIPv4(h);
  }
  if (h === "localhost" || vrEndsWith(h, ".localhost")) {
    return VR_DIRECT;
  }
  return vrRouteDomain(h);
}

function vrEndsWith(value, suffix) {
  return value.length >= suffix.length &&
    value.substring(value.length - suffix.length) === suffix;
}

function vrRoute(code) {
  return code === 1 ? VR_VPN : VR_DIRECT;
}

function vrRouteDomain(h) {
  var key = "e:" + h;
  if (VR_HAS_OWN.call(VR_ROUTES, key)) {
    return vrRoute(VR_ROUTES[key]);
  }
  var suffix = h;
  for (;;) {
    key = "d:" + suffix;
    if (VR_HAS_OWN.call(VR_ROUTES, key)) {
      return vrRoute(VR_ROUTES[key]);
    }
    var dot = suffix.indexOf(".");
    if (dot === -1) {
      return VR_DEFAULT;
    }
    suffix = suffix.substring(dot + 1);
  }
}

function vrParseIPv4(text) {
  var parts = text.split(".");
  if (parts.length !== 4) {
    return null;
  }
  var octets = [];
  for (var i = 0; i < 4; i++) {
    if (!VR_OCTET.test(parts[i])) {
      return null;
    }
    var value = parseInt(parts[i], 10);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }
  return octets;
}

function vrIsLocalIPv4(a, b) {
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
}

function vrRouteIPv4(h) {
  var octets = vrParseIPv4(h);
  if (octets === null) {
    return VR_VPN;
  }
  return vrIsLocalIPv4(octets[0], octets[1]) ? VR_DIRECT : VR_DEFAULT;
}

function vrParseIPv6Groups(text, allowIPv4Tail) {
  var groups = [];
  if (text === "") {
    return groups;
  }
  var parts = text.split(":");
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (allowIPv4Tail && i === parts.length - 1 && part.indexOf(".") !== -1) {
      var octets = vrParseIPv4(part);
      if (octets === null) {
        return null;
      }
      groups.push(octets[0] * 256 + octets[1], octets[2] * 256 + octets[3]);
    } else if (VR_HEX_GROUP.test(part)) {
      groups.push(parseInt(part, 16));
    } else {
      return null;
    }
  }
  return groups;
}

function vrParseIPv6(text) {
  if (!VR_IPV6_CHARS.test(text)) {
    return null;
  }
  var halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  var head = vrParseIPv6Groups(halves[0], halves.length === 1);
  if (head === null) {
    return null;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  var tail = vrParseIPv6Groups(halves[1], true);
  if (tail === null || head.length + tail.length > 7) {
    return null;
  }
  while (head.length + tail.length < 8) {
    head.push(0);
  }
  return head.concat(tail);
}

function vrIsLocalIPv6(g) {
  var zeroPrefix = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (zeroPrefix && g[5] === 65535) {
    return vrIsLocalIPv4(g[6] >> 8, g[6] & 255);
  }
  if (zeroPrefix && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) {
    return true;
  }
  return (g[0] & 65024) === 64512 || (g[0] & 65472) === 65152;
}

function vrRouteIPv6(h) {
  var groups = vrParseIPv6(h);
  if (groups === null) {
    return VR_VPN;
  }
  return vrIsLocalIPv6(groups) ? VR_DIRECT : VR_DEFAULT;
}
`;
