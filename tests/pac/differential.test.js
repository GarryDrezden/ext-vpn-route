import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BlockList, isIP } from "node:net";
import { compileBrowserRoutingState, matchBrowserRoute } from "../../src/domain/browser-routing/index.js";
import { FORCED_LOCAL_POLICY } from "../../src/pac/index.js";
import { mulberry32, pick, shuffle, state } from "../domain/browser-routing/helpers.js";
import { DIRECT, VPN, pacFor, toPacRoute } from "./helpers.js";

const SEED = 20261003;
const LABELS = [
  "a", "b", "ab", "ba", "com", "org", "ru", "example", "notexample", "www", "cdn", "x1", "a-b", "_dmarc",
  "youtube", "google", "xn--p1ai", "xn--e1afmkfd", "__proto__", "constructor", "hasownproperty",
  "tostring", "valueof", "e", "d", "1", "0"
];
const GLUE_LABELS = LABELS.filter((label) => !/^[0-9]+$/.test(label) && !label.startsWith("xn--"));
const MATCH_TYPES = ["ExactHost", "DomainAndSubdomains"];
const ROUTES = ["VPN", "Direct", "Default"];

function randomHost(random, minLabels, maxLabels) {
  const count = minLabels + Math.floor(random() * (maxLabels - minLabels + 1));
  const labels = Array.from({ length: count }, () => pick(random, LABELS));
  while (/^[0-9]+$/.test(labels[labels.length - 1])) labels[labels.length - 1] = pick(random, LABELS);
  return labels.join(".");
}

function randomState(random, size) {
  const rules = [];
  const keys = new Set();
  let attempts = 0;
  while (rules.length < size && attempts++ < size * 10) {
    const host = randomHost(random, 1, 4);
    const matchType = pick(random, MATCH_TYPES);
    const enabled = random() > 0.2;
    if (enabled && keys.has(matchType + " " + host)) continue;
    if (enabled) keys.add(matchType + " " + host);
    rules.push({
      id: "g" + rules.length,
      name: "generated \"" + rules.length + "\"",
      host: random() > 0.8 ? host.toUpperCase() + "." : host,
      matchType,
      routeMode: pick(random, ROUTES),
      enabled,
      source: random() > 0.9 ? "System" : "User",
      notes: random() > 0.7 ? "note </script> \" \\ \u2028" : null
    });
  }
  return state(rules, { defaultRoute: pick(random, ["VPN", "Direct"]), revision: Math.floor(random() * 1e6) });
}

function hostsFor(random, s) {
  const hosts = [];
  for (let i = 0; i < 20; i++) hosts.push(randomHost(random, 1, 5));
  for (const rule of s.rules) {
    const base = rule.host.toLowerCase().replace(/\.$/, "");
    const label = pick(random, GLUE_LABELS);
    hosts.push(base, label + "." + base, label + base, base + "." + label, "a.b." + base);
  }
  return hosts.flatMap((host) => {
    const variants = [host];
    if (random() > 0.7) variants.push(host.toUpperCase());
    if (random() > 0.7) variants.push(host + ".");
    return variants;
  });
}

describe("differential: generated PAC vs Phase 1 matcher on domain hosts", () => {
  test("seeded random states agree host by host", (t) => {
    const random = mulberry32(SEED);
    let states = 0;
    let comparisons = 0;
    let matchedComparisons = 0;
    for (let round = 0; round < 600; round++) {
      const size = round % 50 === 0 ? 300 : Math.floor(random() * 25);
      const s = randomState(random, size);
      const pac = pacFor(s);
      states++;
      const hosts = hostsFor(random, s);
      const actual = pac.findMany(hosts);
      const matcher = compileBrowserRoutingState(s);
      assert.equal(matcher.ok, true);
      hosts.forEach((host, index) => {
        const expected = index % 50 === 0 ? matchBrowserRoute(s, host) : matcher.match(host);
        assert.equal(expected.ok, true, `generator produced a non-domain host ${host}`);
        assert.equal(actual[index], toPacRoute(expected.effectiveRoute),
          `${host} revision ${s.revision}: matcher ${expected.reason} ${expected.matchedRuleId}`);
        comparisons++;
        if (expected.matched) matchedComparisons++;
      });
    }
    t.diagnostic(`seed ${SEED}: ${states} states, ${comparisons} host comparisons, ${matchedComparisons} hit a rule`);
    assert.ok(comparisons > 20000);
    assert.ok(matchedComparisons > comparisons / 4);
  });

  test("rule order never changes PAC routing", () => {
    const random = mulberry32(SEED + 1);
    for (let round = 0; round < 100; round++) {
      const s = randomState(random, 2 + Math.floor(random() * 15));
      const hosts = hostsFor(random, s);
      const pac = pacFor(s);
      const shuffled = pacFor(state(shuffle(random, s.rules), { defaultRoute: s.defaultRoute, revision: s.revision }));
      assert.deepEqual(shuffled.findMany(hosts), pac.findMany(hosts));
    }
  });
});

function forcedLocalOracle() {
  const list = new BlockList();
  for (const cidr of FORCED_LOCAL_POLICY.ipv4) {
    const [address, prefix] = cidr.split("/");
    list.addSubnet(address, Number(prefix), "ipv4");
    list.addSubnet("::ffff:" + address, 96 + Number(prefix), "ipv6");
  }
  for (const cidr of FORCED_LOCAL_POLICY.ipv6) {
    const [address, prefix] = cidr.split("/");
    list.addSubnet(address, Number(prefix), "ipv6");
  }
  return (address) => list.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
}

function randomIPv4(random) {
  const anchors = [[0], [10], [127], [169, 254], [172, 16], [172, 31], [172, 15], [172, 32], [192, 168], [192, 169],
    [100, 64], [11], [9], [126], [128], [169, 253], [169, 255], [8, 8]];
  const octets = Array.from({ length: 4 }, () => Math.floor(random() * 256));
  if (random() > 0.3) {
    const anchor = pick(random, anchors);
    anchor.forEach((value, index) => { octets[index] = value; });
  }
  return octets.join(".");
}

function randomIPv6Groups(random) {
  const groups = Array.from({ length: 8 }, () => Math.floor(random() * 65536));
  const mode = Math.floor(random() * 8);
  if (mode === 0) groups[0] = 0xfc00 + Math.floor(random() * 0x200);
  if (mode === 1) groups[0] = 0xfe80 + Math.floor(random() * 0x40);
  if (mode === 2) groups[0] = pick(random, [0xfbff, 0xfe00, 0xfe7f, 0xfec0, 0xff00, 0x2001, 0x2a00]);
  if (mode === 3 || mode === 4) {
    groups.fill(0, 0, 5);
    groups[5] = mode === 3 ? 0xffff : 0;
    const v4 = randomIPv4(random).split(".").map(Number);
    groups[6] = v4[0] * 256 + v4[1];
    groups[7] = v4[2] * 256 + v4[3];
  }
  if (mode === 5) {
    groups.fill(0, 0, 7);
    groups[7] = Math.floor(random() * 3);
  }
  return groups;
}

function formatIPv6(random, groups) {
  const full = groups.map((g) => g.toString(16)).join(":");
  const canonical = new URL("http://[" + full + "]/").hostname.slice(1, -1);
  const variants = [canonical, full, "[" + canonical + "]", canonical.toUpperCase()];
  if (groups[5] === 0xffff && groups.slice(0, 5).every((g) => g === 0)) {
    variants.push("::ffff:" + [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join("."));
  }
  return pick(random, variants);
}

describe("differential: PAC forced-local policy vs net.BlockList oracle", () => {
  test("the oracle itself classifies known addresses", () => {
    const isLocal = forcedLocalOracle();
    for (const address of ["127.0.0.1", "10.1.1.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "0.0.0.0",
      "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      assert.equal(isLocal(address), true, address);
    }
    for (const address of ["8.8.8.8", "172.32.0.1", "100.64.0.1", "2001:db8::1", "fec0::1", "::ffff:8.8.8.8"]) {
      assert.equal(isLocal(address), false, address);
    }
  });

  test("seeded IPv4 and IPv6 literals", (t) => {
    const random = mulberry32(SEED + 2);
    const isLocal = forcedLocalOracle();
    const pacs = { VPN: pacFor(state([], { defaultRoute: "VPN" })), Direct: pacFor(state([], { defaultRoute: "Direct" })) };
    const hosts = Array.from({ length: 6000 }, (_, i) =>
      i % 2 === 1 ? formatIPv6(random, randomIPv6Groups(random)) : randomIPv4(random));
    const expectedLocal = hosts.map((host) => isLocal(host.replace(/^\[|\]$/g, "")));
    const local = expectedLocal.filter(Boolean).length;
    let comparisons = 0;
    for (const defaultRoute of ["VPN", "Direct"]) {
      const actual = pacs[defaultRoute].findMany(hosts);
      hosts.forEach((host, index) => {
        const expected = expectedLocal[index] ? DIRECT : defaultRoute === "VPN" ? VPN : DIRECT;
        assert.equal(actual[index], expected, `${host} with defaultRoute ${defaultRoute}`);
        comparisons++;
      });
    }
    t.diagnostic(`seed ${SEED + 2}: ${comparisons} IP literal comparisons, ${local} local addresses`);
    assert.ok(local > 500 && local < 5500);
  });
});
