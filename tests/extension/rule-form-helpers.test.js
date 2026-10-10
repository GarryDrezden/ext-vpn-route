import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUserRule, hostsFromUserInput } from "../../src/extension/popup/rule-form-helpers.js";
import { MatchType, RouteMode } from "../../src/domain/browser-routing/constants.js";

test("hostsFromUserInput parses multiline and dedupes", () => {
  const result = hostsFromUserInput("Example.COM\nb.com\nb.com, c.com");
  assert.equal(result.ok, true);
  assert.deepEqual(result.hosts, ["example.com", "b.com", "c.com"]);
});

test("buildUserRule emits canonical hosts payload", () => {
  const built = buildUserRule({
    name: "Sites",
    host: "a.com\nb.com",
    matchType: MatchType.DomainAndSubdomains,
    routeMode: RouteMode.VPN,
    enabled: true,
    notes: ""
  }, "rule-abc1234567890ab");
  assert.equal(built.ok, true);
  assert.deepEqual(built.rule.hosts, ["a.com", "b.com"]);
  assert.equal(built.rule.host, "a.com");
});
