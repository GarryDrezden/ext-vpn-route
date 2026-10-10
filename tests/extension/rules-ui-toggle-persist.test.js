import { test } from "node:test";
import assert from "node:assert/strict";
import { createRulesUi } from "../../src/extension/popup/rules-ui.js";
import { createMemoryDraftStore } from "../../src/extension/popup/rule-editor-draft.js";
import { MatchType, RouteMode, RuleSource } from "../../src/domain/browser-routing/constants.js";

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
    type: extra.type,
    tagName: extra.tagName || "div",
    hidden: extra.hidden ?? false,
    disabled: false,
    checked: extra.checked ?? false,
    textContent: "",
    value: "",
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
    setAttribute() {},
    removeAttribute() {},
    addEventListener(type, fn) { this.listeners[type] = fn; }
  };
  return Object.assign(el, extra);
}

function walkTree(root, visit) {
  visit(root);
  for (const child of root._children || []) walkTree(child, visit);
}

function countSwitchInputs(listEl) {
  let count = 0;
  for (const card of listEl._children) {
    walkTree(card, (node) => {
      if (node.className === "switch-input") count++;
    });
  }
  return count;
}

function buildHarness(send) {
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
  rulesList.querySelectorAll = (sel) => {
    const out = [];
    walkTree(rulesList, (node) => {
      if (sel === "button, input" && (node.type === "checkbox" || node.tagName === "button")) out.push(node);
    });
    return out;
  };

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
    createElement(tag) {
      if (tag === "input") return makeEl("dyn-input", { tagName: "input", type: "checkbox" });
      if (tag === "button") return makeEl("dyn-button", { tagName: "button" });
      if (tag === "label") return makeEl("dyn-label", { tagName: "label" });
      if (tag === "details") return makeEl("dyn-details", { tagName: "details" });
      if (tag === "summary") return makeEl("dyn-summary", { tagName: "summary" });
      return makeEl("dyn-" + tag);
    }
  };

  const ui = createRulesUi({
    elements,
    draftStore: createMemoryDraftStore(),
    send,
    onStatus: () => {}
  });
  return { elements, ui };
}

function panelWithRules(rules, writable = true) {
  return {
    available: true,
    writable,
    defaultRoute: RouteMode.Direct,
    rules,
    hint: writable ? null : "read-only"
  };
}

const multiRule = {
  id: "rule-yt",
  name: "YouTube",
  host: "youtube.com",
  hosts: ["youtube.com", "youtu.be"],
  matchType: MatchType.DomainAndSubdomains,
  routeMode: RouteMode.VPN,
  enabled: false,
  source: RuleSource.User,
  notes: null
};

const otherRule = {
  id: "rule-other",
  name: "Other",
  host: "other.test",
  matchType: MatchType.ExactHost,
  routeMode: RouteMode.Direct,
  enabled: true,
  source: RuleSource.User,
  notes: null
};

test("initial render includes toggle for each writable rule card", () => {
  const { elements, ui } = buildHarness(async () => ({ ok: true }));
  ui.renderPanel(panelWithRules([multiRule, otherRule]));
  assert.equal(countSwitchInputs(elements["rules-list"]), 2);
});

test("read-only panel renders cards without toggles", () => {
  const { elements, ui } = buildHarness(async () => ({ ok: true }));
  ui.renderPanel(panelWithRules([multiRule], false));
  assert.equal(countSwitchInputs(elements["rules-list"]), 0);
});

test("successful toggle mutation re-render keeps toggles on all cards", async () => {
  let rules = [multiRule, otherRule];
  const { elements, ui } = buildHarness(async (command, extra) => {
    if (command !== "rulesMutate") return { ok: true };
    rules = rules.map((r) => (r.id === extra.rule.id ? { ...r, enabled: extra.rule.enabled } : r));
    return { ok: true, panel: panelWithRules(rules) };
  });
  ui.renderPanel(panelWithRules(rules));
  assert.equal(countSwitchInputs(elements["rules-list"]), 2);

  const toggle = elements["rules-list"]._children[0];
  let switchInput = null;
  walkTree(toggle, (node) => {
    if (node.className === "switch-input") switchInput = node;
  });
  assert.ok(switchInput);
  await switchInput.listeners.change();

  assert.equal(ui.isPending(), false);
  assert.equal(countSwitchInputs(elements["rules-list"]), 2);
  let enabledState = null;
  walkTree(elements["rules-list"]._children[0], (node) => {
    if (node.className === "switch-input") enabledState = node.checked;
  });
  assert.equal(enabledState, true);
});
