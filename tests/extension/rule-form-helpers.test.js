import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUserRule, hostsFromUserInput, prepareRuleForUpsert } from "../../src/extension/popup/rule-form-helpers.js";
import { MatchType, RouteMode, RuleSource } from "../../src/domain/browser-routing/constants.js";

test("hostsFromUserInput parses multiline and dedupes", () => {
  const result = hostsFromUserInput("Example.COM\nb.com\nb.com, c.com");
  assert.equal(result.ok, true);
  assert.deepEqual(result.hosts, ["example.com", "b.com", "c.com"]);
});

test("prepareRuleForUpsert preserves multi-domain hosts for toggle writes", () => {
  const snapshotRule = {
    id: "rule-yt",
    name: "YouTube",
    host: "youtube.com",
    hosts: ["youtube.com", "youtu.be", "googlevideo.com"],
    matchType: MatchType.DomainAndSubdomains,
    routeMode: RouteMode.VPN,
    enabled: false,
    source: RuleSource.User,
    notes: null
  };
  const upsert = prepareRuleForUpsert(snapshotRule, { enabled: true });
  assert.equal(upsert.enabled, true);
  assert.deepEqual(upsert.hosts, snapshotRule.hosts);
  assert.equal(upsert.host, "youtube.com");
  assert.equal(Object.keys(upsert).sort().join(","), "enabled,host,hosts,id,matchType,name,notes,routeMode,source");
});

test("prepareRuleForUpsert mirrors legacy single-host rules", () => {
  const upsert = prepareRuleForUpsert({
    id: "rule-1",
    name: "One",
    host: "example.com",
    matchType: MatchType.ExactHost,
    routeMode: RouteMode.Direct,
    enabled: true,
    source: RuleSource.User,
    notes: null
  }, { enabled: false });
  assert.deepEqual(upsert.hosts, ["example.com"]);
  assert.equal(upsert.enabled, false);
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
