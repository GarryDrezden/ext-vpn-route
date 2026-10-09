import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MatchType, RouteMode } from "../../src/domain/browser-routing/constants.js";
import { ROOT } from "../../scripts/build-extension.js";
import {
  RULE_EDITOR_DRAFT_KEY,
  createMemoryDraftStore,
  createRuleEditorDraftStore,
  draftHasUserContent,
  normalizeDraftRecord
} from "../../src/extension/popup/rule-editor-draft.js";
import { createRulesUi } from "../../src/extension/popup/rules-ui.js";

const DRAFT_SRC = path.join(ROOT, "src/extension/popup/rule-editor-draft.js");

after(() => {
  delete globalThis.document;
});

function classListStub() {
  const set = new Set();
  return {
    toggle(name, on) { on ? set.add(name) : set.delete(name); },
    add(name) { set.add(name); },
    remove(name) { set.delete(name); }
  };
}

function makeEl(id, extra = {}) {
  const el = {
    id,
    hidden: extra.hidden ?? false,
    disabled: false,
    textContent: "",
    value: "",
    checked: true,
    className: extra.className || "",
    dataset: {},
    classList: classListStub(),
    listeners: {},
    _children: [],
    get firstChild() { return this._children[0] || null; },
    get lastChild() { return this._children[this._children.length - 1] || null; },
    appendChild(c) { this._children.push(c); return c; },
    removeChild(c) {
      const i = this._children.indexOf(c);
      if (i >= 0) this._children.splice(i, 1);
      return c;
    },
    setAttribute(name) { if (name === "hidden") this.hidden = true; },
    removeAttribute(name) { if (name === "hidden") this.hidden = false; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { this.listeners[type] = fn; }
  };
  return Object.assign(el, extra);
}

function buildUi(draftStore, panel, sendImpl) {
  const routeRadios = [
    Object.assign(makeEl("r-vpn"), { name: "rule-route", value: RouteMode.VPN, checked: true }),
    Object.assign(makeEl("r-direct"), { name: "rule-route", value: RouteMode.Direct, checked: false })
  ];
  const routeGroup = makeEl("rule-route-group");
  routeGroup.querySelectorAll = (sel) => {
    if (sel.includes("rule-route") || sel.includes("input")) return routeRadios;
    return [];
  };
  routeGroup.querySelector = (sel) => {
    if (sel.includes(":checked")) return routeRadios.find((r) => r.checked) || routeRadios[0];
    return null;
  };
  const rulesList = makeEl("rules-list");
  rulesList.querySelectorAll = () => [];

  const elements = {
    "rules-root": makeEl("rules-root"),
    "rules-list-view": makeEl("rules-list-view"),
    "rules-editor-view": makeEl("rules-editor-view", { hidden: true }),
    "rules-list": rulesList,
    "rules-empty": makeEl("rules-empty", { hidden: true }),
    "rules-add": makeEl("rules-add", { hidden: true }),
    "rules-add-empty": makeEl("rules-add-empty"),
    "rules-reset": makeEl("rules-reset"),
    "rules-capability-hint": makeEl("rules-capability-hint", { hidden: true }),
    "rules-unavailable": makeEl("rules-unavailable", { hidden: true }),
    "rules-status-message": makeEl("rules-status-message", { hidden: true }),
    "rules-default-route": makeEl("rules-default-route"),
    "rule-editor-title": makeEl("rule-editor-title"),
    "rule-back": makeEl("rule-back"),
    "rule-name": makeEl("rule-name"),
    "rule-host": makeEl("rule-host"),
    "rule-match": makeEl("rule-match"),
    "rule-route-group": routeGroup,
    "rule-enabled": makeEl("rule-enabled"),
    "rule-notes": makeEl("rule-notes"),
    "rule-form-error": makeEl("rule-form-error"),
    "rule-save": makeEl("rule-save"),
    "rule-cancel": makeEl("rule-cancel"),
    "rule-delete-zone": makeEl("rule-delete-zone", { hidden: true }),
    "rule-delete-edit": makeEl("rule-delete-edit"),
    "rules-confirm-bar": makeEl("rules-confirm-bar", { hidden: true }),
    "rules-confirm-text": makeEl("rules-confirm-text"),
    "rules-confirm-ok": makeEl("rules-confirm-ok"),
    "rules-confirm-cancel": makeEl("rules-confirm-cancel")
  };

  globalThis.document = {
    body: { classList: classListStub() },
    createElement(tag) { return makeEl("dyn-" + tag); }
  };

  const sent = [];
  const ui = createRulesUi({
    elements,
    draftStore,
    send: sendImpl ?? (async (command, payload) => {
      sent.push({ command, payload });
      return { ok: true, panel };
    }),
    onStatus: () => {}
  });
  ui.renderPanel(panel);
  return { ui, elements, sent, routeRadios, ready: tick() };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const emptyPanel = {
  available: true,
  writable: true,
  defaultRoute: RouteMode.Direct,
  rules: [],
  hint: null
};

const sampleRule = {
  id: "rule-abcdef012345678",
  name: "IPify",
  host: "api.ipify.org",
  matchType: MatchType.ExactHost,
  routeMode: RouteMode.VPN,
  enabled: true,
  notes: "note"
};

test("draft store uses session area only in chrome adapter", () => {
  const js = readFileSync(DRAFT_SRC, "utf8");
  assert.match(js, /chrome\.storage\.session/);
  assert.doesNotMatch(js, /chrome\.storage\.local/);
});

test("create draft survives popup lifecycle simulation", async () => {
  const store = createMemoryDraftStore();
  const first = buildUi(store, emptyPanel);
  await first.ready;
  const { ui, elements, routeRadios } = first;
  elements["rules-add-empty"].listeners.click();
  await tick();
  elements["rule-name"].value = "IPify";
  elements["rule-host"].value = "api.ipify.org";
  elements["rule-match"].value = MatchType.ExactHost;
  routeSet(routeRadios, RouteMode.VPN);
  elements["rule-enabled"].checked = false;
  elements["rule-notes"].value = "draft note";
  await ui.flushPersistDraft();
  const saved = await store.load();
  assert.equal(saved.mode, "create");
  assert.match(saved.ruleId, /^rule-[a-f0-9]{16}$/);
  assert.equal(saved.fields.name, "IPify");
  assert.equal(saved.fields.host, "api.ipify.org");
  assert.equal(saved.fields.matchType, MatchType.ExactHost);
  assert.equal(saved.fields.routeMode, RouteMode.VPN);
  assert.equal(saved.fields.enabled, false);
  assert.equal(saved.fields.notes, "draft note");

  const ui2 = buildUi(store, emptyPanel);
  await ui2.ready;
  assert.equal(ui2.elements["rule-name"].value, "IPify");
  assert.equal(ui2.elements["rule-host"].value, "api.ipify.org");
  assert.equal(ui2.elements["rule-match"].value, MatchType.ExactHost);
  assert.equal(getRoute(ui2.routeRadios), RouteMode.VPN);
  assert.equal(ui2.elements["rule-enabled"].checked, false);
  assert.equal(ui2.elements["rule-notes"].value, "draft note");
  assert.equal(ui2.elements["rule-editor-title"].textContent, "Новое правило");
  assert.equal(ui2.ui.isEditorOpen(), true);
  assert.equal(saved.ruleId, (await store.load()).ruleId);
});

function routeSet(radios, mode) {
  for (const input of radios) input.checked = input.value === mode;
}

function getRoute(radios) {
  return radios.find((r) => r.checked).value;
}

/** saveRule() re-persists the draft (new updatedAt); compare semantic content only. */
function assertDraftKept(before, after) {
  assert.ok(after, "draft should still exist");
  assert.equal(after.version, before.version);
  assert.equal(after.mode, before.mode);
  assert.equal(after.ruleId, before.ruleId);
  assert.deepEqual(after.fields, before.fields);
  assert.ok(typeof after.updatedAt === "number" && after.updatedAt >= before.updatedAt);
}

test("successful save clears session draft", async () => {
  const store = createMemoryDraftStore();
  const panel = { ...emptyPanel, rules: [] };
  const harness = buildUi(store, panel, async () => ({ ok: true, panel }));
  await harness.ready;
  const { ui, elements } = harness;
  elements["rules-add-empty"].listeners.click();
  await tick();
  elements["rule-name"].value = "A";
  elements["rule-host"].value = "a.example.com";
  await ui.flushPersistDraft();
  assert.ok(await store.load());
  elements["rule-save"].listeners.click();
  await tick();
  assert.equal(await store.load(), null);
  assert.equal(ui.isEditorOpen(), false);
});

test("cancel clears session draft", async () => {
  const store = createMemoryDraftStore();
  const harness = buildUi(store, emptyPanel);
  await harness.ready;
  const { ui, elements } = harness;
  elements["rules-add-empty"].listeners.click();
  await tick();
  elements["rule-name"].value = "A";
  await ui.flushPersistDraft();
  elements["rule-cancel"].listeners.click();
  await tick();
  assert.equal(await store.load(), null);
});

test("validation_failed keeps draft", async () => {
  const store = createMemoryDraftStore();
  const harness = buildUi(store, emptyPanel, async () => ({
    ok: false, code: "validation_failed", userMessage: "bad", panel: emptyPanel
  }));
  await harness.ready;
  const { ui, elements } = harness;
  elements["rules-add-empty"].listeners.click();
  await tick();
  elements["rule-name"].value = "A";
  elements["rule-host"].value = "a.example.com";
  await ui.flushPersistDraft();
  const before = await store.load();
  elements["rule-save"].listeners.click();
  await tick();
  assertDraftKept(before, await store.load());
  assert.equal(ui.isEditorOpen(), true);
});

test("revision_conflict keeps draft", async () => {
  const store = createMemoryDraftStore();
  const harness = buildUi(store, emptyPanel, async () => ({
    ok: false, conflict: true, code: "revision_conflict", panel: emptyPanel, userMessage: "conflict"
  }));
  await harness.ready;
  const { ui, elements } = harness;
  elements["rules-add-empty"].listeners.click();
  await tick();
  elements["rule-name"].value = "A";
  elements["rule-host"].value = "a.example.com";
  await ui.flushPersistDraft();
  const before = await store.load();
  elements["rule-save"].listeners.click();
  await tick();
  assertDraftKept(before, await store.load());
  assert.equal(ui.isEditorOpen(), true);
});

test("ambiguous transport failure keeps draft", async () => {
  const store = createMemoryDraftStore();
  const harness = buildUi(store, emptyPanel, async () => ({
    ok: false, ambiguous: true, code: "ambiguous_transport", panel: emptyPanel, userMessage: "?"
  }));
  await harness.ready;
  const { ui, elements } = harness;
  elements["rules-add-empty"].listeners.click();
  await tick();
  elements["rule-name"].value = "A";
  elements["rule-host"].value = "a.example.com";
  await ui.flushPersistDraft();
  const before = await store.load();
  elements["rule-save"].listeners.click();
  await tick();
  assertDraftKept(before, await store.load());
  assert.equal(ui.isEditorOpen(), true);
});

test("edit draft restores stable rule id", async () => {
  const store = createMemoryDraftStore();
  const panel = { ...emptyPanel, rules: [sampleRule] };
  const harness = buildUi(store, panel);
  await harness.ready;
  const { ui, elements } = harness;
  const card = elements["rules-list"]._children[0];
  const actions = card._children.find((n) => n.className === "rule-card-actions");
  actions._children.find((n) => n.textContent === "✎").listeners.click();
  await tick();
  elements["rule-name"].value = "Edited";
  await ui.flushPersistDraft();
  const saved = await store.load();
  assert.equal(saved.mode, "edit");
  assert.equal(saved.ruleId, sampleRule.id);

  const ui2 = buildUi(store, panel);
  await ui2.ready;
  assert.equal(ui2.elements["rule-name"].value, "Edited");
  assert.equal(ui2.elements["rule-editor-title"].textContent, "Редактировать правило");
});

test("no draft opens list view", async () => {
  const store = createMemoryDraftStore();
  const harness = buildUi(store, emptyPanel);
  await harness.ready;
  const { ui } = harness;
  assert.equal(ui.isEditorOpen(), false);
});

test("edit draft warns when rule missing from panel", async () => {
  const store = createMemoryDraftStore();
  await store.save(normalizeDraftRecord({
    mode: "edit",
    ruleId: sampleRule.id,
    fields: {
      name: "Ghost",
      host: "api.ipify.org",
      matchType: MatchType.ExactHost,
      routeMode: RouteMode.VPN,
      enabled: true,
      notes: ""
    }
  }));
  const harness = buildUi(store, emptyPanel);
  await harness.ready;
  const { elements } = harness;
  assert.equal(elements["rule-name"].value, "Ghost");
  assert.match(elements["rules-status-message"].textContent, /изменилось|удалено/i);
});

test("memory draft store key is stable", async () => {
  const store = createMemoryDraftStore();
  assert.equal(store.key, RULE_EDITOR_DRAFT_KEY);
  assert.equal(store.storageArea, "session");
});

test("draftHasUserContent detects typed fields", () => {
  assert.equal(draftHasUserContent(null), false);
  assert.equal(draftHasUserContent({ fields: { name: " ", host: "", notes: "" } }), false);
  assert.equal(draftHasUserContent({ fields: { name: "x", host: "", notes: "" } }), true);
});

test("createRuleEditorDraftStore roundtrip", async () => {
  const bag = {};
  const store = createRuleEditorDraftStore({
    get: async (k) => ({ [k]: bag[k] }),
    set: async (items) => { Object.assign(bag, items); },
    remove: async (k) => { delete bag[k]; }
  });
  const record = normalizeDraftRecord({
    mode: "create",
    ruleId: "rule-abcdef012345678",
    fields: {
      name: "n",
      host: "h.example.com",
      matchType: MatchType.DomainAndSubdomains,
      routeMode: RouteMode.Direct,
      enabled: true,
      notes: ""
    }
  });
  await store.save(record);
  const loaded = await store.load();
  assert.equal(loaded.fields.name, "n");
  assert.equal(loaded.ruleId, "rule-abcdef012345678");
});
