import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { matchBrowserRoute, normalizeHost, validateRuleSet } from "../../../src/domain/browser-routing/index.js";
import { mulberry32, pick, shuffle, state } from "./helpers.js";

const LABELS = ["a", "b", "ab", "ba", "ex", "xex", "example", "notexample", "www", "x1", "a-b", "com", "org"];
const ROUTES = ["VPN", "Direct", "Default"];
const MATCH_TYPES = ["ExactHost", "DomainAndSubdomains"];

function randomHost(random, minLabels = 1, maxLabels = 4) {
  const count = minLabels + Math.floor(random() * (maxLabels - minLabels + 1));
  return Array.from({ length: count }, () => pick(random, LABELS)).join(".");
}

function randomRuleSet(random, size) {
  const rules = [];
  const keys = new Set();
  let attempt = 0;
  while (rules.length < size && attempt++ < size * 10) {
    const host = randomHost(random, 1, 3);
    const matchType = pick(random, MATCH_TYPES);
    const enabled = random() > 0.2;
    if (enabled && keys.has(matchType + host)) continue;
    if (enabled) keys.add(matchType + host);
    rules.push({
      id: "p" + rules.length,
      name: "rule " + rules.length,
      host,
      matchType,
      routeMode: pick(random, ROUTES),
      enabled,
      source: "User",
      notes: null
    });
  }
  return rules;
}

function referenceMatch(rules, defaultRoute, host) {
  const active = rules.filter((r) => r.enabled);
  const exactRule = active.find((r) => r.matchType === "ExactHost" && r.host === host);
  let chosen = exactRule;
  if (!chosen) {
    const candidates = active
      .filter((r) => r.matchType === "DomainAndSubdomains" && (host === r.host || host.endsWith("." + r.host)))
      .sort((x, y) => y.host.split(".").length - x.host.split(".").length);
    chosen = candidates[0];
  }
  if (!chosen) return { id: null, route: defaultRoute };
  return { id: chosen.id, route: chosen.routeMode === "Default" ? defaultRoute : chosen.routeMode };
}

describe("properties", () => {
  test("normalizeHost is idempotent on random input", () => {
    const random = mulberry32(1);
    const alphabet = "abcXYZ019-_.:/*?#@ пр\u00DF%[]";
    for (let i = 0; i < 3000; i++) {
      const length = 1 + Math.floor(random() * 20);
      let input = "";
      for (let j = 0; j < length; j++) input += alphabet[Math.floor(random() * alphabet.length)];
      const once = normalizeHost(input);
      if (!once.ok) continue;
      const twice = normalizeHost(once.host);
      assert.equal(twice.ok, true, JSON.stringify(input));
      assert.equal(twice.host, once.host, JSON.stringify(input));
    }
  });

  test("a domain rule never matches across a label boundary", () => {
    const random = mulberry32(2);
    for (let i = 0; i < 2000; i++) {
      const ruleHost = randomHost(random, 1, 3);
      const prefix = pick(random, LABELS);
      const glued = prefix + ruleHost;
      const s = state([{
        id: "d", name: "d", host: ruleHost, matchType: "DomainAndSubdomains",
        routeMode: "VPN", enabled: true, source: "User", notes: null
      }]);
      const isDescendant = (host) => host === ruleHost || host.endsWith("." + ruleHost);
      for (const host of [glued, prefix + "." + ruleHost, ruleHost + "." + prefix, ruleHost + prefix]) {
        assert.equal(matchBrowserRoute(s, host).matched, isDescendant(host), `${ruleHost} vs ${host}`);
      }
      assert.equal(isDescendant(prefix + "." + ruleHost), true);
    }
  });

  test("matcher agrees with a brute-force reference", () => {
    const random = mulberry32(3);
    for (let round = 0; round < 300; round++) {
      const rules = randomRuleSet(random, 1 + Math.floor(random() * 12));
      assert.equal(validateRuleSet(rules).ok, true);
      const defaultRoute = pick(random, ["VPN", "Direct"]);
      const s = state(rules, { defaultRoute });
      for (let q = 0; q < 20; q++) {
        const host = randomHost(random, 1, 5);
        const actual = matchBrowserRoute(s, host);
        const expected = referenceMatch(rules, defaultRoute, host);
        assert.equal(actual.ok, true);
        assert.equal(actual.matchedRuleId, expected.id, `${host} in ${JSON.stringify(rules)}`);
        assert.equal(actual.effectiveRoute, expected.route, host);
      }
    }
  });

  test("rule order does not change any result", () => {
    const random = mulberry32(4);
    for (let round = 0; round < 200; round++) {
      const rules = randomRuleSet(random, 2 + Math.floor(random() * 10));
      const hosts = Array.from({ length: 15 }, () => randomHost(random, 1, 5));
      const base = state(rules);
      const expected = hosts.map((host) => matchBrowserRoute(base, host));
      for (let p = 0; p < 4; p++) {
        const permuted = state(shuffle(random, rules));
        hosts.forEach((host, index) => {
          assert.deepEqual(matchBrowserRoute(permuted, host), expected[index], host);
        });
      }
    }
  });

  test("conflict detection does not depend on rule order", () => {
    const random = mulberry32(5);
    for (let round = 0; round < 200; round++) {
      const rules = randomRuleSet(random, 3 + Math.floor(random() * 6));
      const dup = Object.assign({}, pick(random, rules), { id: "dup", enabled: true });
      const withDup = rules.map((r) => (r.host === dup.host && r.matchType === dup.matchType ? { ...r, enabled: true } : r));
      withDup.push(dup);
      const reference = validateRuleSet(withDup);
      assert.equal(reference.ok, false);
      for (let p = 0; p < 3; p++) {
        const permuted = validateRuleSet(shuffle(random, withDup));
        assert.equal(permuted.ok, false);
        const keys = (result) => result.issues.filter((i) => i.code === "conflicting_rules")
          .map((i) => i.matchType + " " + i.host + " " + i.ruleIds.join(","));
        assert.deepEqual(keys(permuted), keys(reference));
      }
    }
  });
});
