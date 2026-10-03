import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { matchBrowserRoute } from "../../src/domain/browser-routing/index.js";
import { domain, exact, state } from "../domain/browser-routing/helpers.js";
import { DIRECT, VPN, pacFor, toPacRoute } from "./helpers.js";

function expectRoutes(pac, table) {
  for (const [host, expected] of Object.entries(table)) {
    assert.equal(pac.find(host), expected, host);
  }
}

function forBothDefaults(rules, build) {
  for (const defaultRoute of ["Direct", "VPN"]) {
    build(pacFor(state(rules, { defaultRoute })), defaultRoute === "VPN" ? VPN : DIRECT, defaultRoute);
  }
}

describe("PAC basic routes", () => {
  test("empty rules follow defaultRoute", () => {
    expectRoutes(pacFor(state([], { defaultRoute: "Direct" })), { "www.youtube.com": DIRECT, "example.com": DIRECT });
    expectRoutes(pacFor(state([], { defaultRoute: "VPN" })), { "www.youtube.com": VPN, "example.com": VPN });
  });

  test("exact and domain rules with VPN and Direct", () => {
    forBothDefaults([
      exact("exact-vpn.test", "VPN"),
      exact("exact-direct.test", "Direct"),
      domain("domain-vpn.test", "VPN"),
      domain("domain-direct.test", "Direct")
    ], (pac, def) => expectRoutes(pac, {
      "exact-vpn.test": VPN,
      "sub.exact-vpn.test": def,
      "exact-direct.test": DIRECT,
      "sub.exact-direct.test": def,
      "domain-vpn.test": VPN,
      "a.b.domain-vpn.test": VPN,
      "domain-direct.test": DIRECT,
      "www.domain-direct.test": DIRECT,
      "unrelated.test": def
    }));
  });

  test("the spike acceptance call routes YouTube through the proxy", () => {
    const pac = pacFor(state([domain("youtube.com", "VPN")]));
    assert.equal(pac.find("www.youtube.com", "https://www.youtube.com/"), VPN);
    assert.equal(pac.find("example.com", "https://example.com/"), DIRECT);
  });
});

describe("PAC precedence", () => {
  test("exact beats domain on the same host", () => {
    forBothDefaults([domain("example.com", "VPN"), exact("example.com", "Direct")], (pac) => expectRoutes(pac, {
      "example.com": DIRECT,
      "www.example.com": VPN
    }));
  });

  test("a more specific domain beats its parent", () => {
    forBothDefaults([domain("example.com", "VPN"), domain("cdn.example.com", "Direct")], (pac) => expectRoutes(pac, {
      "example.com": VPN,
      "img.cdn.example.com": DIRECT,
      "cdn.example.com": DIRECT,
      "www.example.com": VPN
    }));
  });

  test("Default on an exact rule breaks inheritance from the parent", () => {
    forBothDefaults([domain("example.com", "VPN"), exact("foo.example.com", "Default")], (pac, def) => expectRoutes(pac, {
      "foo.example.com": def,
      "bar.foo.example.com": VPN,
      "bar.example.com": VPN
    }));
  });

  test("Default on a domain rule breaks inheritance for the whole subtree", () => {
    forBothDefaults([domain("example.com", "VPN"), domain("eu.example.com", "Default")], (pac, def) => expectRoutes(pac, {
      "eu.example.com": def,
      "a.b.eu.example.com": def,
      "us.example.com": VPN
    }));
  });

  test("disabled rules are ignored", () => {
    forBothDefaults([
      domain("example.com", "VPN"),
      exact("www.example.com", "Direct", { enabled: false }),
      domain("off.test", "VPN", { enabled: false })
    ], (pac, def) => expectRoutes(pac, {
      "www.example.com": VPN,
      "off.test": def,
      "a.off.test": def
    }));
  });

  test("the contract precedence example", () => {
    const pac = pacFor(state([domain("example.com", "VPN"), exact("foo.example.com", "Default")], { defaultRoute: "Direct" }));
    expectRoutes(pac, { "foo.example.com": DIRECT, "bar.example.com": VPN });
  });
});

describe("PAC label boundaries", () => {
  test("domain rule matches only real descendants", () => {
    forBothDefaults([domain("example.com", "VPN")], (pac, def) => expectRoutes(pac, {
      "example.com": VPN,
      "www.example.com": VPN,
      "a.b.example.com": VPN,
      "notexample.com": def,
      "example.com.evil.org": def,
      "example.co": def,
      "xample.com": def,
      "com": def
    }));
  });

  test("exact rule matches only the full host", () => {
    forBothDefaults([exact("example.com", "VPN")], (pac, def) => expectRoutes(pac, {
      "example.com": VPN,
      "www.example.com": def,
      "notexample.com": def
    }));
  });

  test("hosts named after Object.prototype members are plain data", () => {
    const rules = [domain("__proto__", "VPN"), exact("constructor", "VPN"), domain("hasownproperty", "VPN")];
    forBothDefaults(rules, (pac, def) => expectRoutes(pac, {
      "__proto__": VPN,
      "a.__proto__": VPN,
      "constructor": VPN,
      "a.constructor": def,
      "hasownproperty": VPN,
      "tostring": def,
      "valueof": def,
      "isprototypeof": def
    }));
  });
});

describe("PAC runtime host normalization", () => {
  test("uppercase and one trailing dot are normalized", () => {
    forBothDefaults([domain("youtube.com", "VPN"), exact("ozon.ru", "Direct")], (pac, def) => expectRoutes(pac, {
      "WWW.YouTube.COM": VPN,
      "www.youtube.com.": VPN,
      "OZON.RU.": DIRECT
    }));
  });

  test("canonical Punycode hosts match IDN rules", () => {
    const rules = [domain("xn--c1aapkosapc.xn--p1ai", "VPN"), exact("xn--e1afmkfd.xn--p1ai", "Direct")];
    forBothDefaults(rules, (pac) => expectRoutes(pac, {
      "xn--c1aapkosapc.xn--p1ai": VPN,
      "www.xn--c1aapkosapc.xn--p1ai": VPN,
      "XN--C1AAPKOSAPC.XN--P1AI": VPN,
      "xn--e1afmkfd.xn--p1ai": DIRECT
    }));
  });

  test("non-ASCII runtime host is never approximated and fails closed to the proxy", () => {
    const rules = [domain("ozon.ru", "Direct"), domain("example.com", "Direct")];
    forBothDefaults(rules, (pac) => expectRoutes(pac, {
      "госуслуги.рф": VPN,
      "\u212Aexample.com": VPN,
      "ozon.ru\u3002": VPN,
      "\uFF4Fzon.ru": VPN,
      "exаmple.com": VPN
    }));
  });

  test("unclassifiable ASCII hosts fail closed to the proxy", () => {
    forBothDefaults([domain("example.com", "Direct")], (pac) => {
      for (const host of ["", ".", "..", "a..example.com", ".example.com", "exa mple.com", "example.com:443",
        "user@example.com", "example.com/x", "*.example.com", "ex%41mple.com", "[example.com]", "[", "[]",
        "example.com..", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1.2.3.04", "a".repeat(254)]) {
        assert.equal(pac.find(host), VPN, JSON.stringify(host));
      }
    });
  });

  test("non-string host fails closed to the proxy", () => {
    const pac = pacFor(state([], { defaultRoute: "Direct" }));
    for (const host of [undefined, null, 42, {}]) {
      assert.equal(pac.find(host, "https://x/"), VPN);
    }
  });
});

describe("PAC single-label hosts", () => {
  test("single-label hosts follow rules and defaultRoute, not an implicit DIRECT", () => {
    expectRoutes(pacFor(state([], { defaultRoute: "VPN" })), { "intranet": VPN, "router": VPN });
    expectRoutes(pacFor(state([], { defaultRoute: "Direct" })), { "intranet": DIRECT });
    expectRoutes(pacFor(state([exact("intranet", "Direct")], { defaultRoute: "VPN" })), { "intranet": DIRECT, "wiki": VPN });
    expectRoutes(pacFor(state([domain("corp", "VPN")], { defaultRoute: "Direct" })), { "corp": VPN, "a.corp": VPN });
  });
});

describe("PAC default routes for unmatched and IP literal hosts", () => {
  test("public domain, IPv4 and IPv6 literals use defaultRoute", () => {
    forBothDefaults([domain("youtube.com", "Direct")], (pac, def) => expectRoutes(pac, {
      "unknown-public.example": def,
      "8.8.8.8": def,
      "1.1.1.1": def,
      "2001:4860:4860::8888": def,
      "[2001:4860:4860::8888]": def,
      "2a00:1450:4001:82a::200e": def,
      "::ffff:8.8.8.8": def
    }));
  });
});

describe("PAC forced-local policy", () => {
  const local = [
    "localhost", "LOCALHOST", "localhost.", "foo.localhost", "a.b.localhost",
    "127.0.0.1", "127.255.255.255", "127.1.2.3",
    "10.0.0.0", "10.255.255.255", "10.1.2.3", "10.0.0.1.",
    "172.16.0.0", "172.20.1.1", "172.31.255.255",
    "192.168.0.0", "192.168.255.255",
    "169.254.0.0", "169.254.169.254",
    "0.0.0.0", "0.255.255.255",
    "::1", "[::1]", "0:0:0:0:0:0:0:1", "::",
    "fc00::", "fc00::1", "fd00::1", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "FD12:3456::1",
    "fe80::", "fe80::1", "fe9a::1", "feab::1", "febf:ffff::1", "[fe80::1]",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:192.168.1.1", "::ffff:a00:1"
  ];
  const publicNearby = [
    "172.15.255.255", "172.32.0.0", "192.169.0.1", "192.167.255.255", "11.0.0.1", "9.255.255.255",
    "126.255.255.255", "128.0.0.0", "169.253.255.255", "169.255.0.0", "1.0.0.0",
    "100.64.0.1", "100.127.255.255",
    "::2", "fbff::1", "fe00::1", "fe7f::1", "fec0::1", "ff02::1", "2001:db8::1", "::ffff:8.8.8.8",
    "::ffff:172.32.0.1", "64:ff9b::a00:1", "::a00:1", "1::1"
  ];

  test("local and private literals are DIRECT even with defaultRoute VPN and VPN rules", () => {
    const rules = [domain("localhost", "VPN"), exact("foo.localhost", "VPN")];
    for (const defaultRoute of ["VPN", "Direct"]) {
      const pac = pacFor(state(rules, { defaultRoute }));
      for (const host of local) assert.equal(pac.find(host), DIRECT, host);
    }
  });

  test("nearby public addresses are not classified as local", () => {
    for (const defaultRoute of ["VPN", "Direct"]) {
      const pac = pacFor(state([], { defaultRoute }));
      const def = defaultRoute === "VPN" ? VPN : DIRECT;
      for (const host of publicNearby) assert.equal(pac.find(host), def, host);
    }
  });

  test("names that only look local are domain hosts", () => {
    const pac = pacFor(state([], { defaultRoute: "VPN" }));
    expectRoutes(pac, {
      "localhost.com": VPN,
      "notlocalhost": VPN,
      "localhostx": VPN,
      "localhost.evil.org": VPN,
      "127.0.0.1.nip.io": VPN,
      "10.0.0.1.example.com": VPN
    });
  });
});

describe("PAC fail-closed invariant", () => {
  test("no public IPv6 literal leaks to DIRECT under defaultRoute VPN", () => {
    const pac = pacFor(state([domain("example.com", "Direct")], { defaultRoute: "VPN" }));
    for (const host of ["2001:db8::1", "2a00::", "::ffff:1.2.3.4", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:1.2.3.4",
      "1::", "1:2:3:4:5:6:7::", "::2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:9", "1:::2", "12345::1", "g::1", ":1::2",
      "1::2:", "fe80::1%eth0", "::ffff:1.2.3", "1.2.3.4::", "[2001:db8::1", "2001:db8::1]"]) {
      assert.equal(pac.find(host), VPN, host);
    }
  });

  test("VPN output is the bare SOCKS5 endpoint", () => {
    const pac = pacFor(state([domain("youtube.com", "VPN")], { defaultRoute: "VPN" }));
    for (const host of ["www.youtube.com", "example.com", "8.8.8.8", "2001:db8::1", "\u00e9.com"]) {
      const result = pac.find(host);
      assert.equal(result, VPN, host);
      assert.equal(result.includes(";"), false);
      assert.equal(result.includes("DIRECT"), false);
    }
  });

  test("custom loopback endpoint is used verbatim", () => {
    const pac = pacFor(state([domain("youtube.com", "VPN")]), { proxyHost: "127.0.0.2", proxyPort: 1080 });
    assert.equal(pac.find("www.youtube.com"), "SOCKS5 127.0.0.2:1080");
  });
});

describe("PAC agrees with the Phase 1 matcher on the example state", () => {
  test("acceptance sites", async () => {
    const { readFile } = await import("node:fs/promises");
    const example = JSON.parse(await readFile(new URL("../../docs/examples/browser-routing-state-v1.json", import.meta.url), "utf8"));
    const pac = pacFor(example);
    for (const host of ["www.youtube.com", "chatgpt.com", "mail.google.com", "maps.google.com", "www.ozon.ru",
      "www.gosuslugi.ru", "example.com", "google.com", "a.maps.google.com"]) {
      assert.equal(pac.find(host), toPacRoute(matchBrowserRoute(example, host).effectiveRoute), host);
    }
  });
});
