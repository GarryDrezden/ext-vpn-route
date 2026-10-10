import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MatchType, RouteMode, RuleSource } from "../../src/domain/browser-routing/constants.js";
import { labelMatchType, labelRouteMode } from "../../src/extension/popup/rules-labels.js";
import { buildUserRule, generateRuleId, hostFromUserInput } from "../../src/extension/popup/rule-form-helpers.js";
import {
  RulesMessage,
  buildFixtureRulesPanelView,
  buildRulesPanelView,
  executeRulesMutation
} from "../../src/extension/runtime/rules-panel.js";
import { ServiceWriteErrorCode, WriterErrorCode } from "../../src/extension/state/browser-routing-writer.js";
import { GEN_A, INTEGRATION_V1, routingState } from "./fakes.js";
import { parseIntegrationManifest } from "../../src/extension/state/integration-manifest.js";

function snapshotFetch(revision, rules, caps) {
  const manifest = {
    schemaVersion: 1,
    stateGeneration: GEN_A,
    revision,
    defaultRoute: "Direct",
    ruleCount: rules.length,
    pageBudgetBytes: 520192,
    browserProxy: { status: "Ready", endpoint: { host: "127.0.0.1", port: 1 } },
    ...INTEGRATION_V1,
    capabilities: caps || INTEGRATION_V1.capabilities
  };
  const parsed = parseIntegrationManifest(manifest);
  const state = routingState(revision, { rules });
  return {
    ok: true,
    integration: parsed.integration,
    snapshot: {
      identity: { stateGeneration: GEN_A, revision },
      state,
      browserProxy: manifest.browserProxy
    }
  };
}

describe("rules labels", () => {
  test("human labels for match types", () => {
    assert.equal(labelMatchType(MatchType.ExactHost), "Только этот домен");
    assert.equal(labelMatchType(MatchType.DomainAndSubdomains), "Домен и поддомены");
  });
  test("human labels for route modes", () => {
    assert.equal(labelRouteMode(RouteMode.VPN), "Через VPN");
    assert.equal(labelRouteMode(RouteMode.Direct), "Напрямую");
  });
});

describe("rules panel view", () => {
  test("empty rules state", () => {
    const view = buildRulesPanelView(snapshotFetch(0, []));
    assert.equal(view.available, true);
    assert.equal(view.rules.length, 0);
    assert.equal(view.writable, true);
  });

  test("capability absent is read-only", () => {
    const caps = INTEGRATION_V1.capabilities.filter((c) => c !== "browserRoutingWrite");
    const view = buildRulesPanelView(snapshotFetch(1, [], caps));
    assert.equal(view.writable, false);
    assert.match(view.hint, /не поддерживает/);
  });

  test("failed snapshot is unavailable", () => {
    const view = buildRulesPanelView({ ok: false });
    assert.equal(view.available, false);
    assert.equal(view.writable, false);
  });
});

describe("rule form helpers", () => {
  test("generates stable-format id", () => {
    const id = generateRuleId();
    assert.match(id, /^rule-[a-f0-9]{16}$/);
  });

  test("buildUserRule sets User source", () => {
    const built = buildUserRule({
      name: "Test",
      host: "example.com",
      matchType: MatchType.ExactHost,
      routeMode: RouteMode.VPN,
      enabled: true
    });
    assert.equal(built.ok, true);
    assert.equal(built.rule.source, RuleSource.User);
  });

  test("hostFromUserInput strips https URL", () => {
    const r = hostFromUserInput("https://example.com/path");
    assert.equal(r.ok, true);
    assert.equal(r.host, "example.com");
  });
});

describe("executeRulesMutation", () => {
  const sampleRule = Object.freeze({
    id: "rule-abc",
    name: "S",
    host: "site.test",
    matchType: MatchType.ExactHost,
    routeMode: RouteMode.VPN,
    enabled: true,
    source: RuleSource.User,
    notes: null
  });

  function deps(overrides = {}) {
    let revision = overrides.revision ?? 5;
    const rules = [...(overrides.rules || [sampleRule])];
    const writer = {
      upsertRule: overrides.upsertRule || (async ({ expectedRevision, rule }) => {
        assert.equal(expectedRevision, revision);
        if (rule.id === sampleRule.id) Object.assign(sampleRule, rule);
        else rules.push(rule);
        revision += 1;
        return { ok: true, result: { stateGeneration: GEN_A, revision, defaultRoute: "Direct", ruleCount: rules.length } };
      }),
      deleteRule: overrides.deleteRule || (async ({ expectedRevision, id }) => {
        assert.equal(expectedRevision, revision);
        const idx = rules.findIndex((r) => r.id === id);
        if (idx < 0) return { ok: false, error: { code: ServiceWriteErrorCode.NotFound, message: "missing" } };
        rules.splice(idx, 1);
        revision += 1;
        return { ok: true, result: { stateGeneration: GEN_A, revision, defaultRoute: "Direct", ruleCount: rules.length } };
      }),
      resetRules: overrides.resetRules || (async ({ expectedRevision }) => {
        assert.equal(expectedRevision, revision);
        rules.length = 0;
        revision += 1;
        return { ok: true, result: { stateGeneration: GEN_A, revision, defaultRoute: "Direct", ruleCount: 0 } };
      })
    };
    return {
      getSnapshot: async () => snapshotFetch(revision, rules),
      writer,
      sync: async () => ({ mode: "Native", protection: "CURRENT", source: null, diagnostics: { status: "APPLIED" } }),
      formatView: (v) => v,
      get revision() { return revision; },
      get rules() { return rules; }
    };
  }

  test("multi-domain disabled rule toggle ON sends hosts[] with expectedRevision", async () => {
    const multiRule = Object.freeze({
      id: "rule-multi",
      name: "YouTube",
      host: "youtube.com",
      hosts: ["youtube.com", "youtu.be"],
      matchType: MatchType.DomainAndSubdomains,
      routeMode: RouteMode.VPN,
      enabled: false,
      source: RuleSource.User,
      notes: null
    });
    let captured = null;
    const d = deps({
      rules: [multiRule],
      upsertRule: async ({ expectedRevision, rule }) => {
        captured = { expectedRevision, rule };
        return {
          ok: true,
          result: { stateGeneration: GEN_A, revision: 6, defaultRoute: "Direct", ruleCount: 1 }
        };
      }
    });
    const result = await executeRulesMutation(d, "upsert", {
      rule: { ...multiRule, enabled: true }
    });
    assert.equal(result.ok, true);
    assert.equal(captured.expectedRevision, 5);
    assert.deepEqual(captured.rule.hosts, multiRule.hosts);
    assert.equal(captured.rule.enabled, true);
    assert.equal(captured.rule.host, "youtube.com");
  });

  test("toggle OFF preserves hosts unchanged", async () => {
    const multiRule = Object.freeze({
      id: "rule-multi",
      name: "Sites",
      host: "a.com",
      hosts: ["a.com", "b.com"],
      matchType: MatchType.ExactHost,
      routeMode: RouteMode.VPN,
      enabled: true,
      source: RuleSource.User,
      notes: null
    });
    let captured = null;
    const d = deps({
      rules: [multiRule],
      upsertRule: async ({ rule }) => {
        captured = rule;
        return {
          ok: true,
          result: { stateGeneration: GEN_A, revision: 6, defaultRoute: "Direct", ruleCount: 1 }
        };
      }
    });
    await executeRulesMutation(d, "upsert", { rule: { ...multiRule, enabled: false } });
    assert.deepEqual(captured.hosts, ["a.com", "b.com"]);
    assert.equal(captured.enabled, false);
  });

  test("invalid_request from host surfaces message without auto-retry", async () => {
    let calls = 0;
    const d = deps({
      upsertRule: async () => {
        calls++;
        return { ok: false, error: { code: ServiceWriteErrorCode.InvalidRequest, message: "Request envelope is invalid." } };
      }
    });
    const result = await executeRulesMutation(d, "upsert", { rule: sampleRule });
    assert.equal(calls, 1);
    assert.equal(result.code, "validation_failed");
    assert.equal(result.userMessage, "Request envelope is invalid.");
  });

  test("add uses current expectedRevision", async () => {
    const d = deps();
    const newRule = { ...sampleRule, id: "rule-new", host: "new.test" };
    const result = await executeRulesMutation(d, "upsert", { rule: newRule });
    assert.equal(result.ok, true);
    assert.equal(d.rules.length, 2);
  });

  test("conflict message is neutral (desktop + other clients)", () => {
    assert.equal(
      RulesMessage.conflict,
      "Правила изменились. Список обновлён — проверьте изменения и сохраните ещё раз."
    );
  });

  test("conflict does not auto-resubmit", async () => {
    let calls = 0;
    const d = deps({
      upsertRule: async () => {
        calls++;
        return { ok: false, error: { code: ServiceWriteErrorCode.RevisionConflict, message: "x", currentRevision: 9 } };
      }
    });
    const result = await executeRulesMutation(d, "upsert", { rule: sampleRule });
    assert.equal(calls, 1);
    assert.equal(result.conflict, true);
    assert.equal(result.userMessage, RulesMessage.conflict);
  });

  test("ambiguous transport triggers sync not replay", async () => {
    let calls = 0;
    let syncs = 0;
    const d = deps({
      upsertRule: async () => {
        calls++;
        return { ok: false, error: { code: WriterErrorCode.Timeout, message: "timeout" } };
      }
    });
    d.sync = async () => { syncs++; return d.formatView({}); };
    const result = await executeRulesMutation(d, "upsert", { rule: sampleRule });
    assert.equal(calls, 1);
    assert.equal(syncs, 1);
    assert.equal(result.ambiguous, true);
  });

  test("delete not_found refreshes", async () => {
    const d = deps({ rules: [] });
    const result = await executeRulesMutation(d, "delete", { id: "missing" });
    assert.equal(result.code, "not_found");
  });

  test("resetRules uses current revision", async () => {
    const d = deps();
    const result = await executeRulesMutation(d, "reset", {});
    assert.equal(result.ok, true);
    assert.equal(d.rules.length, 0);
  });
});
