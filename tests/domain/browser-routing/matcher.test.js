import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  MatchError,
  MatchReason,
  compileBrowserRoutingState,
  matchBrowserRoute
} from "../../../src/domain/browser-routing/index.js";
import { deepFreeze, domain, exact, state } from "./helpers.js";

function route(s, host) {
  const result = matchBrowserRoute(s, host);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

describe("exact match", () => {
  const rules = [exact("video.example.com", "VPN", { id: "exact-video" })];

  test("matches the same host", () => {
    const result = route(state(rules), "video.example.com");
    assert.equal(result.matched, true);
    assert.equal(result.matchedRuleId, "exact-video");
    assert.equal(result.matchType, "ExactHost");
    assert.equal(result.effectiveRoute, "VPN");
    assert.equal(result.reason, MatchReason.ExactRule);
  });

  test("normalizes case and trailing dot of the input", () => {
    const result = route(state(rules), "VIDEO.Example.com.");
    assert.equal(result.inputHost, "VIDEO.Example.com.");
    assert.equal(result.normalizedHost, "video.example.com");
    assert.equal(result.effectiveRoute, "VPN");
  });

  test("normalizes the rule host too", () => {
    const result = route(state([exact("VIDEO.Example.com.", "VPN")]), "video.example.com");
    assert.equal(result.matchedRuleHost, "video.example.com");
  });

  test("does not match a subdomain", () => {
    const result = route(state(rules), "a.video.example.com");
    assert.equal(result.matched, false);
    assert.equal(result.reason, MatchReason.BrowserDefault);
  });

  test("does not match the parent", () => {
    assert.equal(route(state(rules), "example.com").matched, false);
  });
});

describe("domain match", () => {
  const rules = [domain("example.com", "VPN", { id: "dom" })];

  test("matches the root domain itself", () => {
    const result = route(state(rules), "example.com");
    assert.equal(result.matchedRuleId, "dom");
    assert.equal(result.reason, MatchReason.DomainRule);
    assert.equal(result.effectiveRoute, "VPN");
  });

  test("matches one and many subdomain levels", () => {
    for (const host of ["www.example.com", "a.b.example.com", "x.y.z.w.example.com"]) {
      assert.equal(route(state(rules), host).matchedRuleId, "dom", host);
    }
  });

  test("respects the label boundary", () => {
    for (const host of ["badexample.com", "notexample.com", "example.com.evil.org", "example.co", "xample.com",
      "example.comm", "wwwexample.com", "example-com.org", "com"]) {
      const result = route(state(rules), host);
      assert.equal(result.matched, false, host);
      assert.equal(result.reason, MatchReason.BrowserDefault, host);
    }
  });

  test("youtube negative cases", () => {
    const s = state([domain("youtube.com", "VPN")]);
    assert.equal(route(s, "youtube.com").effectiveRoute, "VPN");
    assert.equal(route(s, "www.youtube.com").effectiveRoute, "VPN");
    assert.equal(route(s, "evilyoutube.com").matched, false);
    assert.equal(route(s, "youtube.com.evil.org").matched, false);
  });
});

describe("precedence", () => {
  const s = state([
    domain("example.com", "VPN", { id: "root" }),
    domain("foo.example.com", "Direct", { id: "foo" }),
    exact("bar.foo.example.com", "VPN", { id: "bar" })
  ]);

  test("spec example", () => {
    assert.deepEqual(
      ["bar.foo.example.com", "x.foo.example.com", "foo.example.com", "x.example.com", "other.org"]
        .map((host) => { const r = route(s, host); return [r.matchedRuleId, r.effectiveRoute, r.reason]; }),
      [
        ["bar", "VPN", MatchReason.ExactRule],
        ["foo", "Direct", MatchReason.DomainRule],
        ["foo", "Direct", MatchReason.DomainRule],
        ["root", "VPN", MatchReason.DomainRule],
        [null, "Direct", MatchReason.BrowserDefault]
      ]);
  });

  test("exact beats a domain rule on the same host", () => {
    const result = route(state([domain("example.com", "VPN"), exact("example.com", "Direct", { id: "e" })]), "example.com");
    assert.equal(result.matchedRuleId, "e");
    assert.equal(result.effectiveRoute, "Direct");
  });

  test("exact on the same host does not shadow subdomains", () => {
    const result = route(state([domain("example.com", "VPN", { id: "d" }), exact("example.com", "Direct")]), "www.example.com");
    assert.equal(result.matchedRuleId, "d");
  });

  test("specificity is by labels, not by string length", () => {
    const s2 = state([
      domain("a.b.example.com", "VPN", { id: "three-short" }),
      domain("bbbbbbbbbbbbbbbbbbbbbbbbbbbb.example.com", "Direct", { id: "long" })
    ]);
    assert.equal(route(s2, "x.a.b.example.com").matchedRuleId, "three-short");
    assert.equal(route(s2, "x.bbbbbbbbbbbbbbbbbbbbbbbbbbbb.example.com").matchedRuleId, "long");
  });

  test("unrelated rules are ignored", () => {
    const result = route(state([domain("other.org", "VPN"), exact("x.example.net", "VPN")]), "example.com");
    assert.equal(result.matched, false);
  });
});

describe("enabled flag", () => {
  test("disabled rule is ignored", () => {
    const result = route(state([domain("example.com", "VPN", { enabled: false })]), "www.example.com");
    assert.equal(result.matched, false);
    assert.equal(result.effectiveRoute, "Direct");
  });

  test("disabled specific rule falls through to the enabled parent", () => {
    const result = route(state([
      domain("example.com", "VPN", { id: "parent" }),
      exact("www.example.com", "Direct", { enabled: false })
    ]), "www.example.com");
    assert.equal(result.matchedRuleId, "parent");
  });

  test("disabled duplicate leaves the enabled one in force", () => {
    const result = route(state([
      exact("example.com", "VPN", { id: "on" }),
      exact("example.com", "Direct", { id: "off", enabled: false })
    ]), "example.com");
    assert.equal(result.matchedRuleId, "on");
  });
});

describe("RouteMode.Default", () => {
  test("no rule uses browser default", () => {
    for (const defaultRoute of ["Direct", "VPN"]) {
      const result = route(state([], { defaultRoute }), "example.com");
      assert.equal(result.effectiveRoute, defaultRoute);
      assert.equal(result.reason, MatchReason.BrowserDefault);
      assert.equal(result.matched, false);
    }
  });

  test("exact Default breaks inheritance from a VPN parent (browser default Direct)", () => {
    const s = state([domain("example.com", "VPN"), exact("foo.example.com", "Default", { id: "brk" })],
      { defaultRoute: "Direct" });
    const result = route(s, "foo.example.com");
    assert.equal(result.matched, true);
    assert.equal(result.matchedRuleId, "brk");
    assert.equal(result.ruleRouteMode, "Default");
    assert.equal(result.effectiveRoute, "Direct");
    assert.equal(result.reason, MatchReason.ExplicitDefault);
    assert.equal(route(s, "bar.example.com").effectiveRoute, "VPN");
  });

  test("exact Default breaks inheritance from a Direct parent (browser default VPN)", () => {
    const s = state([domain("example.com", "Direct"), exact("foo.example.com", "Default")], { defaultRoute: "VPN" });
    assert.equal(route(s, "foo.example.com").effectiveRoute, "VPN");
    assert.equal(route(s, "bar.example.com").effectiveRoute, "Direct");
  });

  test("domain Default overrides a less specific parent", () => {
    const s = state([
      domain("google.com", "VPN", { id: "google" }),
      domain("maps.google.com", "Default", { id: "maps" })
    ], { defaultRoute: "Direct" });
    const result = route(s, "a.maps.google.com");
    assert.equal(result.matchedRuleId, "maps");
    assert.equal(result.matchType, "DomainAndSubdomains");
    assert.equal(result.effectiveRoute, "Direct");
    assert.equal(result.reason, MatchReason.ExplicitDefault);
    assert.equal(route(s, "mail.google.com").effectiveRoute, "VPN");
  });

  test("Default with browser default VPN gives VPN, not the parent's Direct", () => {
    const s = state([domain("example.com", "Direct"), domain("a.example.com", "Default")], { defaultRoute: "VPN" });
    assert.equal(route(s, "x.a.example.com").effectiveRoute, "VPN");
  });

  test("Default on a root rule equals browser default but is reported as matched", () => {
    const result = route(state([domain("example.com", "Default")], { defaultRoute: "VPN" }), "example.com");
    assert.equal(result.matched, true);
    assert.equal(result.effectiveRoute, "VPN");
  });
});

describe("IDN", () => {
  test("Unicode rule matches equivalent Punycode input", () => {
    const result = route(state([domain("пример.рф", "VPN")]), "www.xn--e1afmkfd.xn--p1ai");
    assert.equal(result.matchedRuleHost, "xn--e1afmkfd.xn--p1ai");
    assert.equal(result.effectiveRoute, "VPN");
  });

  test("Punycode rule matches equivalent Unicode input", () => {
    const result = route(state([exact("xn--e1afmkfd.xn--p1ai", "VPN")]), "ПРИМЕР.РФ");
    assert.equal(result.normalizedHost, "xn--e1afmkfd.xn--p1ai");
    assert.equal(result.effectiveRoute, "VPN");
  });
});

describe("fail-safe", () => {
  test("invalid state gives no route", () => {
    const result = matchBrowserRoute(state([exact("example.com", "VPN"), exact("example.com", "Direct")]), "example.com");
    assert.equal(result.ok, false);
    assert.equal(result.error.code, MatchError.InvalidState);
    assert.equal("effectiveRoute" in result, false);
    assert.ok(result.issues.length > 0);
  });

  test("Default as browser default gives no route", () => {
    const result = matchBrowserRoute(state([], { defaultRoute: "Default" }), "example.com");
    assert.equal(result.ok, false);
    assert.equal("effectiveRoute" in result, false);
  });

  test("invalid input host gives no route", () => {
    const s = state([domain("example.com", "VPN")], { defaultRoute: "Direct" });
    for (const host of ["https://example.com", "1.2.3.4", "[::1]", "", "*.example.com", null, 5]) {
      const result = matchBrowserRoute(s, host);
      assert.equal(result.ok, false, String(host));
      assert.equal(result.error.code, MatchError.InvalidHost);
      assert.equal("effectiveRoute" in result, false);
    }
  });

  test("compiled matcher reports invalid state up front", () => {
    const compiled = compileBrowserRoutingState(state([], { schemaVersion: 2 }));
    assert.equal(compiled.ok, false);
    assert.equal(compiled.match, undefined);
  });
});

describe("purity", () => {
  test("matching does not mutate state or rules", () => {
    const s = state([domain("Example.COM.", "VPN"), exact("foo.example.com", "Default")]);
    const before = JSON.stringify(s);
    route(s, "foo.example.com");
    route(s, "www.example.com");
    assert.equal(JSON.stringify(s), before);
  });

  test("works on deeply frozen input", () => {
    const s = deepFreeze(state([domain("example.com", "VPN")]));
    assert.equal(route(s, "www.example.com").effectiveRoute, "VPN");
  });

  test("results are frozen and the compiled state is isolated from later input changes", () => {
    const s = state([domain("example.com", "VPN")]);
    const compiled = compileBrowserRoutingState(s);
    s.rules[0].routeMode = "Direct";
    s.defaultRoute = "VPN";
    const result = compiled.match("www.example.com");
    assert.equal(result.effectiveRoute, "VPN");
    assert.equal(compiled.match("other.org").effectiveRoute, "Direct");
    assert.ok(Object.isFrozen(result));
  });

  test("same state and host give the same result", () => {
    const s = state([domain("example.com", "VPN"), exact("a.example.com", "Default")]);
    assert.deepEqual(route(s, "a.example.com"), route(s, "a.example.com"));
  });

  test("result carries the state revision and JSON round-trips", () => {
    const result = route(state([domain("example.com", "VPN")], { revision: 42 }), "www.example.com");
    assert.equal(result.stateRevision, 42);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { ...result });
  });
});
