import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DEFAULT_ROUTES,
  MATCH_TYPES,
  MatchReason,
  ROUTE_MODES,
  RULE_SOURCES,
  SCHEMA_VERSION,
  matchBrowserRoute,
  validateBrowserRoutingState
} from "../../../src/domain/browser-routing/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const domainDir = path.join(root, "src/domain/browser-routing");
const example = JSON.parse(readFileSync(path.join(root, "docs/examples/browser-routing-state-v1.json"), "utf8"));
const contractDoc = readFileSync(path.join(root, "docs/browser-routing-contract-v1.md"), "utf8");

describe("contract v1", () => {
  test("enum values are fixed", () => {
    assert.equal(SCHEMA_VERSION, 1);
    assert.deepEqual([...MATCH_TYPES], ["ExactHost", "DomainAndSubdomains"]);
    assert.deepEqual([...ROUTE_MODES], ["Default", "VPN", "Direct"]);
    assert.deepEqual([...DEFAULT_ROUTES], ["VPN", "Direct"]);
    assert.deepEqual([...RULE_SOURCES], ["User", "System"]);
    assert.deepEqual(Object.values(MatchReason), ["exact_rule", "domain_rule", "explicit_default", "browser_default"]);
  });

  test("contract document names every enum value", () => {
    for (const value of [...MATCH_TYPES, ...ROUTE_MODES, ...RULE_SOURCES, ...Object.values(MatchReason)]) {
      assert.ok(contractDoc.includes("`" + value + "`"), value);
    }
  });

  test("example state is valid and already canonical", () => {
    const result = validateBrowserRoutingState(example);
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.deepEqual(JSON.parse(JSON.stringify(result.state)), example);
  });

  test("example state routes the V1 acceptance sites", () => {
    const expect = {
      "www.youtube.com": ["VPN", "youtube"],
      "chatgpt.com": ["VPN", "chatgpt"],
      "mail.google.com": ["VPN", "google"],
      "maps.google.com": ["Direct", "google-maps"],
      "www.ozon.ru": ["Direct", "ozon"],
      "www.gosuslugi.ru": ["Direct", null],
      "example.com": ["Direct", null]
    };
    for (const [host, [route, ruleId]] of Object.entries(expect)) {
      const result = matchBrowserRoute(example, host);
      assert.equal(result.effectiveRoute, route, host);
      assert.equal(result.matchedRuleId, ruleId, host);
    }
  });

  test("match result has exactly the documented fields", () => {
    const result = matchBrowserRoute(example, "www.youtube.com");
    assert.deepEqual(Object.keys(result).sort(), [
      "effectiveRoute", "inputHost", "matchType", "matched", "matchedRuleHost", "matchedRuleId",
      "matchedRuleName", "normalizedHost", "ok", "reason", "ruleRouteMode", "stateRevision"
    ]);
  });

  test("state and match result survive a JSON round trip", () => {
    const parsed = JSON.parse(JSON.stringify(example));
    assert.deepEqual(matchBrowserRoute(parsed, "maps.google.com"), matchBrowserRoute(example, "maps.google.com"));
  });
});

describe("domain module boundary", () => {
  const files = readdirSync(domainDir).filter((name) => name.endsWith(".js"));

  test("domain sources do not use browser, DOM, Node or network APIs", () => {
    const forbidden = [
      /\bchrome\./, /\bbrowser\./, /\bdocument\./, /\bwindow\./, /\bglobalThis\./, /\blocalStorage\b/, /\bindexedDB\b/,
      /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bprocess\./, /\brequire\s*\(/,
      /from\s+["']node:/, /import\s*\(/, /\bDate\b/, /Math\.random/, /\bsetTimeout\b/, /\beval\s*\(/,
      /new\s+Function/, /DIRECT/
    ];
    assert.ok(files.length >= 5);
    for (const name of files) {
      const source = readFileSync(path.join(domainDir, name), "utf8");
      for (const pattern of forbidden) {
        assert.equal(pattern.test(source), false, `${name} matches ${pattern}`);
      }
    }
  });

  test("domain modules only import each other", () => {
    for (const name of files) {
      const source = readFileSync(path.join(domainDir, name), "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        assert.ok(match[1].startsWith("./"), `${name} imports ${match[1]}`);
      }
    }
  });
});
