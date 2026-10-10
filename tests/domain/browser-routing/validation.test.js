import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  IssueCode,
  validateBrowserRoutingState,
  validateRule,
  validateRuleSet
} from "../../../src/domain/browser-routing/index.js";
import { codes, deepFreeze, domain, exact, state } from "./helpers.js";

describe("validateRule", () => {
  test("valid rule is returned in canonical form", () => {
    const input = exact("WWW.Example.COM.", "VPN", { id: "abc_1-2" });
    const result = validateRule(input);
    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.rule.hosts, ["www.example.com"]);
    assert.equal(result.rule.host, "www.example.com");
    assert.equal(result.rule.id, "abc_1-2");
    assert.ok(Object.isFrozen(result.rule));
    assert.equal(input.host, "WWW.Example.COM.");
  });

  test("absent notes becomes null, string notes are kept", () => {
    const withoutNotes = exact("example.com", "VPN");
    delete withoutNotes.notes;
    assert.equal(validateRule(withoutNotes).rule.notes, null);
    assert.equal(validateRule(exact("example.com", "VPN", { notes: "line 1\nline 2\ttab" })).rule.notes,
      "line 1\nline 2\ttab");
  });

  test("non-object", () => {
    for (const value of [null, 1, "x", [], undefined]) {
      assert.deepEqual(codes(validateRule(value).issues), [IssueCode.InvalidType]);
    }
  });

  test("missing required fields are each reported", () => {
    const result = validateRule({}, "/rules/0");
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((entry) => entry.path).sort(), [
      "/rules/0/enabled", "/rules/0/hosts", "/rules/0/id", "/rules/0/matchType",
      "/rules/0/name", "/rules/0/routeMode", "/rules/0/source"
    ]);
    assert.ok(result.issues.every((entry) => entry.code === IssueCode.MissingField));
  });

  test("unknown field is rejected", () => {
    const result = validateRule(exact("example.com", "VPN", { fallback: "DIRECT" }), "/rules/2");
    assert.deepEqual(codes(result.issues), [IssueCode.UnknownField]);
    assert.equal(result.issues[0].path, "/rules/2/fallback");
  });

  test("invalid id", () => {
    for (const id of ["", "a b", "x".repeat(65), 7, null, "id/1", "ид"]) {
      assert.deepEqual(codes(validateRule(exact("example.com", "VPN", { id })).issues), [IssueCode.InvalidId], String(id));
    }
  });

  test("invalid name", () => {
    for (const name of ["", "   ", "x".repeat(121), 5, null, "bad\u0007name", "two\nlines"]) {
      assert.deepEqual(codes(validateRule(exact("example.com", "VPN", { name })).issues), [IssueCode.InvalidName], String(name));
    }
  });

  test("invalid host carries the host error code", () => {
    const result = validateRule(exact("https://example.com", "VPN"), "/rules/0");
    assert.deepEqual(codes(result.issues), [IssueCode.InvalidHost]);
    assert.equal(result.issues[0].hostError, "has_scheme");
    assert.equal(result.issues[0].path, "/rules/0/host");
  });

  test("unknown enum values are not accepted", () => {
    assert.deepEqual(codes(validateRule(exact("example.com", "VPN", { matchType: "Wildcard" })).issues),
      [IssueCode.UnknownMatchType]);
    assert.deepEqual(codes(validateRule(exact("example.com", "VPN", { matchType: "exacthost" })).issues),
      [IssueCode.UnknownMatchType]);
    assert.deepEqual(codes(validateRule(exact("example.com", "Proxy")).issues), [IssueCode.UnknownRouteMode]);
    assert.deepEqual(codes(validateRule(exact("example.com", "vpn")).issues), [IssueCode.UnknownRouteMode]);
    assert.deepEqual(codes(validateRule(exact("example.com", "VPN", { source: "TabDock" })).issues),
      [IssueCode.UnknownSource]);
    assert.deepEqual(codes(validateRule(exact("example.com", "VPN", { source: "Yandex" })).issues),
      [IssueCode.UnknownSource]);
  });

  test("enabled must be boolean", () => {
    for (const enabled of ["true", 1, null, 0]) {
      assert.deepEqual(codes(validateRule(exact("example.com", "VPN", { enabled })).issues), [IssueCode.InvalidEnabled]);
    }
  });

  test("notes limits", () => {
    for (const notes of [5, "x".repeat(1001), "bell\u0007", {}]) {
      assert.deepEqual(codes(validateRule(exact("example.com", "VPN", { notes })).issues), [IssueCode.InvalidNotes]);
    }
    assert.equal(validateRule(exact("example.com", "VPN", { notes: "x".repeat(1000) })).ok, true);
  });

  test("System source is valid", () => {
    assert.equal(validateRule(exact("example.com", "Direct", { source: "System" })).ok, true);
  });

  test("multiple problems are all reported", () => {
    const result = validateRule({ id: "", name: "", host: "*.x", matchType: "?", routeMode: "?", enabled: "?", source: "?" });
    assert.deepEqual(codes(result.issues).sort(), [
      IssueCode.InvalidEnabled, IssueCode.InvalidHost, IssueCode.InvalidId, IssueCode.InvalidName,
      IssueCode.UnknownMatchType, IssueCode.UnknownRouteMode, IssueCode.UnknownSource
    ].sort());
  });
});

describe("validateRuleSet: duplicates and conflicts", () => {
  test("exact duplicate with different routeMode conflicts", () => {
    const a = exact("example.com", "VPN");
    const b = exact("example.com", "Direct");
    const result = validateRuleSet([a, b]);
    assert.equal(result.ok, false);
    assert.equal(result.rules, null);
    assert.deepEqual(codes(result.issues), [IssueCode.ConflictingRules]);
    const conflict = result.issues[0];
    assert.equal(conflict.host, "example.com");
    assert.equal(conflict.matchType, "ExactHost");
    assert.deepEqual([...conflict.ruleIds], [a.id, b.id].sort());
    assert.deepEqual([...conflict.paths], ["/rules/0", "/rules/1"]);
  });

  test("duplicate with the same routeMode still conflicts", () => {
    const result = validateRuleSet([domain("example.com", "VPN"), domain("example.com", "VPN")]);
    assert.deepEqual(codes(result.issues), [IssueCode.ConflictingRules]);
  });

  test("domain duplicate conflicts", () => {
    const result = validateRuleSet([domain("example.com", "VPN"), domain("example.com", "Default")]);
    assert.deepEqual(codes(result.issues), [IssueCode.ConflictingRules]);
    assert.equal(result.issues[0].matchType, "DomainAndSubdomains");
  });

  test("same host with ExactHost and DomainAndSubdomains is allowed", () => {
    const result = validateRuleSet([exact("example.com", "Direct"), domain("example.com", "VPN")]);
    assert.equal(result.ok, true);
    assert.equal(result.rules.length, 2);
  });

  test("canonical duplicates are detected", () => {
    const result = validateRuleSet([
      exact("Example.COM", "VPN"),
      exact("example.com.", "Direct"),
      exact(" example.com ", "Default")
    ]);
    assert.deepEqual(codes(result.issues), [IssueCode.ConflictingRules]);
    assert.equal(result.issues[0].ruleIds.length, 3);
  });

  test("Unicode and Punycode duplicates are detected", () => {
    const result = validateRuleSet([domain("пример.рф", "VPN"), domain("xn--e1afmkfd.xn--p1ai", "Direct")]);
    assert.deepEqual(codes(result.issues), [IssueCode.ConflictingRules]);
    assert.equal(result.issues[0].host, "xn--e1afmkfd.xn--p1ai");
  });

  test("disabled duplicate does not create an active conflict", () => {
    const result = validateRuleSet([exact("example.com", "VPN"), exact("example.com", "Direct", { enabled: false })]);
    assert.equal(result.ok, true);
  });

  test("two disabled duplicates do not conflict", () => {
    const result = validateRuleSet([
      exact("example.com", "VPN", { enabled: false }),
      exact("example.com", "Direct", { enabled: false })
    ]);
    assert.equal(result.ok, true);
  });

  test("enabling a duplicate creates a conflict", () => {
    const a = exact("example.com", "VPN");
    const b = exact("example.com", "Direct", { enabled: false });
    assert.equal(validateRuleSet([a, b]).ok, true);
    const result = validateRuleSet([a, Object.assign({}, b, { enabled: true })]);
    assert.deepEqual(codes(result.issues), [IssueCode.ConflictingRules]);
  });

  test("duplicate rule ids are rejected even for disabled rules", () => {
    const result = validateRuleSet([
      exact("a.example.com", "VPN", { id: "same" }),
      exact("b.example.com", "VPN", { id: "same", enabled: false })
    ]);
    assert.deepEqual(codes(result.issues), [IssueCode.DuplicateRuleId]);
    assert.equal(result.issues[0].path, "/rules/1/id");
    assert.equal(result.issues[0].firstPath, "/rules/0/id");
  });

  test("an invalid disabled rule still invalidates the set", () => {
    const result = validateRuleSet([exact("*.example.com", "VPN", { enabled: false })]);
    assert.deepEqual(codes(result.issues), [IssueCode.InvalidHost]);
  });

  test("conflict issues are ordered deterministically", () => {
    const rules = [
      exact("b.com", "VPN"), exact("b.com", "Direct"),
      exact("a.com", "VPN"), exact("a.com", "Direct")
    ];
    const hosts = validateRuleSet(rules).issues.map((entry) => entry.host);
    assert.deepEqual(hosts, ["a.com", "b.com"]);
  });

  test("not an array", () => {
    assert.deepEqual(codes(validateRuleSet({}).issues), [IssueCode.InvalidType]);
  });

  test("too many rules", () => {
    const rules = new Array(10001).fill(null);
    assert.deepEqual(codes(validateRuleSet(rules).issues), [IssueCode.TooManyRules]);
  });

  test("multi-host rule conflicts on any shared host", () => {
    const multi = Object.assign({}, exact("a.com", "VPN"), { hosts: ["a.com", "b.com"] });
    delete multi.host;
    const bOnly = Object.assign({}, exact("b.com", "Direct"));
    delete bOnly.host;
    bOnly.hosts = ["b.com"];
    const result = validateRuleSet([multi, bOnly]);
    assert.deepEqual(codes(result.issues), [IssueCode.ConflictingRules]);
    assert.equal(result.issues[0].host, "b.com");
  });

  test("duplicate hosts within one rule are deduped", () => {
    const input = Object.assign({}, domain("example.com", "VPN"), {
      hosts: ["Example.COM", "example.com.", " b.com ", "b.com"]
    });
    delete input.host;
    const result = validateRule(input);
    assert.equal(result.ok, true);
    assert.deepEqual(result.rule.hosts, ["example.com", "b.com"]);
  });
});

describe("validateRule: hosts field", () => {
  test("legacy host migrates to hosts", () => {
    const result = validateRule(exact("Example.COM.", "VPN"));
    assert.deepEqual(result.rule.hosts, ["example.com"]);
    assert.equal(result.rule.host, "example.com");
  });

  test("host and hosts together require matching primary host", () => {
    const ok = Object.assign({}, exact("example.com", "VPN"), { hosts: ["example.com"] });
    assert.equal(validateRule(ok).ok, true);
    const bad = Object.assign({}, exact("example.com", "VPN"), { hosts: ["other.com"] });
    assert.deepEqual(codes(validateRule(bad).issues), [IssueCode.InvalidType]);
  });

  test("empty hosts array is invalid", () => {
    const input = exact("example.com", "VPN", { hosts: [] });
    delete input.host;
    assert.deepEqual(codes(validateRule(input).issues), [IssueCode.InvalidHost]);
  });
});

describe("validateBrowserRoutingState", () => {
  test("valid state is returned canonical and frozen", () => {
    const input = state([domain("YouTube.com", "VPN")], { revision: 7, defaultRoute: "Direct" });
    const result = validateBrowserRoutingState(input);
    assert.equal(result.ok, true);
    assert.equal(result.state.revision, 7);
    assert.equal(result.state.rules[0].host, "youtube.com");
    assert.ok(Object.isFrozen(result.state));
    assert.ok(Object.isFrozen(result.state.rules));
    assert.equal(input.rules[0].host, "YouTube.com");
  });

  test("empty rule list is valid", () => {
    assert.equal(validateBrowserRoutingState(state([])).ok, true);
  });

  test("schemaVersion must be exactly 1", () => {
    for (const schemaVersion of [0, 2, "1", null, 1.5]) {
      assert.deepEqual(codes(validateBrowserRoutingState(state([], { schemaVersion })).issues),
        [IssueCode.UnsupportedSchemaVersion], String(schemaVersion));
    }
  });

  test("defaultRoute cannot be Default", () => {
    const result = validateBrowserRoutingState(state([], { defaultRoute: "Default" }));
    assert.deepEqual(codes(result.issues), [IssueCode.InvalidDefaultRoute]);
  });

  test("defaultRoute must be a known value", () => {
    for (const defaultRoute of ["vpn", "DIRECT", "", null, 1]) {
      assert.deepEqual(codes(validateBrowserRoutingState(state([], { defaultRoute })).issues),
        [IssueCode.InvalidDefaultRoute]);
    }
    assert.equal(validateBrowserRoutingState(state([], { defaultRoute: "VPN" })).ok, true);
  });

  test("revision must be a non-negative safe integer", () => {
    for (const revision of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      assert.deepEqual(codes(validateBrowserRoutingState(state([], { revision })).issues),
        [IssueCode.InvalidRevision], String(revision));
    }
    assert.equal(validateBrowserRoutingState(state([], { revision: 0 })).ok, true);
    assert.equal(validateBrowserRoutingState(state([], { revision: Number.MAX_SAFE_INTEGER })).ok, true);
  });

  test("missing and unknown top-level fields", () => {
    const result = validateBrowserRoutingState({ schemaVersion: 1, extra: true });
    assert.deepEqual(result.issues.map((entry) => entry.path).sort(),
      ["/defaultRoute", "/extra", "/revision", "/rules"]);
  });

  test("invalid rule makes the state invalid with a pointer to it", () => {
    const result = validateBrowserRoutingState(state([exact("example.com", "VPN"), exact("example.com:443", "VPN")]));
    assert.equal(result.ok, false);
    assert.equal(result.state, null);
    assert.equal(result.issues[0].path, "/rules/1/host");
  });

  test("non-object state", () => {
    for (const value of [null, [], "state", 1]) {
      assert.deepEqual(codes(validateBrowserRoutingState(value).issues), [IssueCode.InvalidType]);
    }
  });

  test("validation does not mutate frozen input", () => {
    const input = deepFreeze(state([domain("Example.COM.", "VPN")]));
    const before = JSON.stringify(input);
    assert.equal(validateBrowserRoutingState(input).ok, true);
    assert.equal(JSON.stringify(input), before);
  });
});
