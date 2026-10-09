import { test } from "node:test";
import assert from "node:assert/strict";
import { createRulesUi } from "../../src/extension/popup/rules-ui.js";
import { createMemoryDraftStore } from "../../src/extension/popup/rule-editor-draft.js";
import { MatchType, RouteMode } from "../../src/domain/browser-routing/constants.js";

function classListStub() {
  const set = new Set();
  return {
    toggle(name, on) { on ? set.add(name) : set.delete(name); },
    add(name) { set.add(name); },
    remove(name) { set.delete(name); },
    has(name) { return set.has(name); }
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
    querySelectorAll() { return []; },
    setAttribute(name) { if (name === "hidden") this.hidden = true; },
    removeAttribute(name) { if (name === "hidden") this.hidden = false; },
    addEventListener(type, fn) { this.listeners[type] = fn; }
  };
  return Object.assign(el, extra);
}

function buildRulesUiHarness() {
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

  const ui = createRulesUi({
    elements,
    draftStore: createMemoryDraftStore(),
    send: async () => ({ ok: true }),
    onStatus: () => {}
  });

  return { ui, elements };
}

const sampleRule = {
  id: "rule-persisted",
  name: "Persisted",
  host: "host.test",
  matchType: MatchType.ExactHost,
  routeMode: RouteMode.Direct,
  enabled: true
};

function panelWithRules(rules) {
  return {
    available: true,
    writable: true,
    defaultRoute: RouteMode.Direct,
    rules,
    hint: null
  };
}

test("header add hidden when rules=0, empty add visible", () => {
  const { elements, ui } = buildRulesUiHarness();
  ui.renderPanel(panelWithRules([]));
  assert.equal(elements["rules-add"].hidden, true);
  assert.equal(elements["rules-empty"].hidden, false);
});

test("header add visible when rules>0, empty hidden", () => {
  const { elements, ui } = buildRulesUiHarness();
  ui.renderPanel(panelWithRules([sampleRule]));
  assert.equal(elements["rules-add"].hidden, false);
  assert.equal(elements["rules-empty"].hidden, true);
});

test("delete zone hidden in create mode", async () => {
  const { elements, ui } = buildRulesUiHarness();
  ui.renderPanel(panelWithRules([]));
  elements["rules-add-empty"].listeners.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(elements["rule-editor-title"].textContent, "Новое правило");
  assert.equal(elements["rule-delete-zone"].hidden, true);
});

test("delete zone visible only when editing persisted rule", async () => {
  const { elements, ui } = buildRulesUiHarness();
  ui.renderPanel(panelWithRules([sampleRule]));
  const card = elements["rules-list"]._children[0];
  const actions = card._children.find((n) => n.className === "rule-card-actions");
  const editBtn = actions._children.find((n) => n.textContent === "✎");
  editBtn.listeners.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(elements["rule-editor-title"].textContent, "Редактировать правило");
  assert.equal(elements["rule-delete-zone"].hidden, false);
});
