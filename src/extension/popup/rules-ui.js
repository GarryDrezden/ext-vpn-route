import { MatchType, RouteMode } from "../../domain/browser-routing/constants.js";
import { formatRuleHostsLabel, labelMatchType, labelRouteMode } from "./rules-labels.js";
import { buildUserRule, generateRuleId, prepareRuleForUpsert } from "./rule-form-helpers.js";
import {
  createChromeSessionDraftStore,
  draftHasUserContent,
  normalizeDraftRecord
} from "./rule-editor-draft.js";

const DRAFT_PERSIST_MS = 150;
const EDIT_RULE_MISSING_MSG =
  "Правило изменилось или было удалено. Проверьте данные перед сохранением.";

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function textEl(tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

function iconButton(label, className, ariaLabel) {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  el.className = className;
  if (ariaLabel) el.setAttribute("aria-label", ariaLabel);
  return el;
}

function routeBadgeClass(mode) {
  if (mode === RouteMode.VPN) return "pill pill-vpn";
  if (mode === RouteMode.Direct) return "pill pill-direct";
  return "pill pill-default";
}

function matchBadgeLabel(matchType) {
  if (matchType === MatchType.DomainAndSubdomains) return "Домен + поддомены";
  if (matchType === MatchType.ExactHost) return "Только домен";
  return labelMatchType(matchType);
}

/**
 * @param {{
 *   elements: Record<string, HTMLElement>,
 *   send: (command: string, payload?: object) => Promise<any>,
 *   onStatus: (response: any) => void,
 *   draftStore?: { load(): Promise<object|null>, save(record: object): Promise<void>, clear(): Promise<void> }
 * }} deps
 */
export function createRulesUi(deps) {
  const els = deps.elements;
  const draftStore = deps.draftStore ?? createChromeSessionDraftStore();
  let panel = null;
  let mutationPending = false;
  let editingRuleId = null;
  let editorMode = null;
  let draft = null;
  let editorOpen = false;
  let confirmOpen = false;
  let sessionRestoreAttempted = false;
  let persistTimer = null;
  let pendingDiscardEditRule = null;

  function setMessage(text, tone) {
    const box = els["rules-status-message"];
    if (!text) {
      box.hidden = true;
      box.textContent = "";
      box.className = "rules-message";
      return;
    }
    box.hidden = false;
    box.textContent = text;
    box.className = "rules-message" + (tone ? " " + tone : "");
  }

  function setRouteMode(value) {
    const group = els["rule-route-group"];
    for (const input of group.querySelectorAll('input[name="rule-route"]')) {
      input.checked = input.value === value;
    }
  }

  function getRouteMode() {
    const group = els["rule-route-group"];
    const checked = group.querySelector
      ? group.querySelector('input[name="rule-route"]:checked')
      : group.querySelectorAll('input[name="rule-route"]').find((i) => i.checked);
    return checked ? checked.value : RouteMode.VPN;
  }

  function setViewMode(mode) {
    const list = els["rules-list-view"];
    const editor = els["rules-editor-view"];
    editorOpen = mode === "editor";
    list.hidden = editorOpen || confirmOpen;
    editor.hidden = !editorOpen || confirmOpen;
    document.body.classList.toggle("view-list", mode === "list" && !confirmOpen);
    document.body.classList.toggle("view-editor", editorOpen && !confirmOpen);
    document.body.classList.toggle("view-confirm", confirmOpen);
    const root = els["rules-root"];
    if (root) root.classList.toggle("rules-root--flat", editorOpen && !confirmOpen);
  }

  function setDeleteZoneVisible(visible) {
    const zone = els["rule-delete-zone"];
    zone.hidden = !visible;
    if (visible) zone.removeAttribute("hidden");
    else zone.setAttribute("hidden", "");
  }

  function syncHeaderAddButton() {
    const add = els["rules-add"];
    const showCompact =
      panel && panel.available && panel.rules.length > 0 && !editorOpen && !confirmOpen;
    add.hidden = !showCompact;
    if (showCompact) add.removeAttribute("hidden");
    else add.setAttribute("hidden", "");
  }

  function readFormFields() {
    return {
      name: els["rule-name"].value,
      host: els["rule-host"].value,
      matchType: els["rule-match"].value,
      routeMode: getRouteMode(),
      enabled: els["rule-enabled"].checked,
      notes: els["rule-notes"].value
    };
  }

  function hostsToEditorText(ruleOrFields) {
    if (Array.isArray(ruleOrFields.hosts) && ruleOrFields.hosts.length > 0) {
      return ruleOrFields.hosts.join("\n");
    }
    return String(ruleOrFields.host ?? "");
  }

  function applyFormFields(fields) {
    els["rule-name"].value = fields.name ?? "";
    els["rule-host"].value = hostsToEditorText(fields);
    els["rule-match"].value = fields.matchType ?? MatchType.DomainAndSubdomains;
    setRouteMode(fields.routeMode ?? RouteMode.VPN);
    els["rule-enabled"].checked = fields.enabled !== false;
    els["rule-notes"].value = fields.notes ?? "";
  }

  function buildDraftRecord() {
    if (!editorOpen || !editorMode) return null;
    return normalizeDraftRecord({
      mode: editorMode,
      ruleId: editingRuleId,
      fields: readFormFields(),
      updatedAt: Date.now()
    });
  }

  async function persistDraftNow() {
    if (!editorOpen || !editorMode) return;
    const record = buildDraftRecord();
    if (record) await draftStore.save(record);
  }

  function schedulePersistDraft() {
    if (!editorOpen) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistDraftNow();
    }, DRAFT_PERSIST_MS);
  }

  async function flushPersistDraft() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persistDraftNow();
  }

  function showListView() {
    editingRuleId = null;
    editorMode = null;
    draft = null;
    els["rule-form-error"].textContent = "";
    setDeleteZoneVisible(false);
    setViewMode("list");
    syncHeaderAddButton();
  }

  async function cancelEditor() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await draftStore.clear();
    showListView();
  }

  function showEditorView() {
    confirmOpen = false;
    els["rules-confirm-bar"].hidden = true;
    setViewMode("editor");
    syncHeaderAddButton();
  }

  function setControlsDisabled(disabled) {
    mutationPending = disabled;
    const ids = ["rules-add", "rules-add-empty", "rules-reset", "rule-save", "rule-cancel", "rule-back", "rule-delete-edit"];
    for (const id of ids) {
      if (els[id]) els[id].disabled = disabled;
    }
    els["rules-list"].querySelectorAll("button, input").forEach((b) => { b.disabled = disabled; });
    if (editorOpen) {
      els["rule-name"].disabled = disabled;
      els["rule-host"].disabled = disabled;
      els["rule-match"].disabled = disabled;
      els["rule-enabled"].disabled = disabled;
      els["rule-notes"].disabled = disabled;
      els["rule-route-group"].querySelectorAll("input").forEach((i) => { i.disabled = disabled; });
    }
    if (confirmOpen) {
      els["rules-confirm-ok"].disabled = disabled;
      els["rules-confirm-cancel"].disabled = disabled;
    }
  }

  function renderRuleCard(rule) {
    const li = document.createElement("li");
    li.className = "rule-card" + (rule.enabled ? "" : " rule-disabled");

    const main = document.createElement("div");
    main.className = "rule-card-main";

    const head = document.createElement("div");
    head.className = "rule-card-head";
    head.appendChild(textEl("span", rule.name, "rule-card-name"));
    const badges = document.createElement("div");
    badges.className = "rule-badges";
    badges.appendChild(textEl("span", labelRouteMode(rule.routeMode), routeBadgeClass(rule.routeMode)));
    badges.appendChild(textEl("span", matchBadgeLabel(rule.matchType), "pill pill-match"));
    if (!rule.enabled) badges.appendChild(textEl("span", "Выключено", "pill pill-off"));
    head.appendChild(badges);
    main.appendChild(head);
    main.appendChild(textEl("div", formatRuleHostsLabel(rule), "rule-card-host"));

    const actions = document.createElement("div");
    actions.className = "rule-card-actions";

    if (panel.writable) {
      const toggleLabel = document.createElement("label");
      toggleLabel.className = "switch switch-compact";
      toggleLabel.title = rule.enabled ? "Выключить правило" : "Включить правило";
      const toggleInput = document.createElement("input");
      toggleInput.type = "checkbox";
      toggleInput.className = "switch-input";
      toggleInput.checked = rule.enabled;
      toggleInput.setAttribute("aria-label", rule.enabled ? "Правило включено" : "Правило выключено");
      toggleInput.disabled = mutationPending;
      toggleInput.addEventListener("change", () => toggleRule(rule));
      toggleLabel.appendChild(toggleInput);
      const track = document.createElement("span");
      track.className = "switch-track";
      track.setAttribute("aria-hidden", "true");
      toggleLabel.appendChild(track);
      actions.appendChild(toggleLabel);

      actions.appendChild(iconButton("✎", "btn-icon btn-quiet", "Изменить"));
      actions.lastChild.addEventListener("click", () => { void beginEditRule(rule); });

      const menu = document.createElement("details");
      menu.className = "rule-menu";
      const summary = document.createElement("summary");
      summary.className = "btn-icon btn-quiet rule-menu-trigger";
      summary.setAttribute("aria-label", "Действия");
      summary.textContent = "⋯";
      menu.appendChild(summary);
      const deleteBtn = iconButton("Удалить", "rule-menu-delete", "Удалить правило");
      deleteBtn.addEventListener("click", (e) => {
        e.preventDefault();
        menu.open = false;
        confirmDelete(rule);
      });
      menu.appendChild(deleteBtn);
      actions.appendChild(menu);
    }

    li.appendChild(main);
    li.appendChild(actions);
    return li;
  }

  function renderList() {
    const list = els["rules-list"];
    clearChildren(list);
    const empty = els["rules-empty"];
    if (!panel || !panel.available) {
      empty.hidden = true;
      return;
    }
    if (panel.rules.length === 0) {
      empty.hidden = false;
      empty.removeAttribute("hidden");
      list.hidden = true;
      syncHeaderAddButton();
      return;
    }
    empty.hidden = true;
    empty.setAttribute("hidden", "");
    list.hidden = false;
    for (const rule of panel.rules) {
      list.appendChild(renderRuleCard(rule));
    }
    syncHeaderAddButton();
  }

  function renderPanel(nextPanel) {
    panel = nextPanel;
    const defaultLabel = panel && panel.defaultRoute
      ? "По умолчанию · " + labelRouteMode(panel.defaultRoute)
      : "—";
    els["rules-default-route"].textContent = defaultLabel;

    const hint = els["rules-capability-hint"];
    if (panel && panel.hint) {
      hint.hidden = false;
      hint.textContent = panel.hint;
    } else {
      hint.hidden = true;
      hint.textContent = "";
    }

    if (!panel || !panel.available) {
      els["rules-unavailable"].hidden = false;
      els["rules-add"].disabled = true;
      if (els["rules-add-empty"]) els["rules-add-empty"].disabled = true;
      els["rules-reset"].disabled = true;
      els["rules-empty"].hidden = true;
      clearChildren(els["rules-list"]);
      if (!editorOpen) showListView();
      return;
    }

    els["rules-unavailable"].hidden = true;
    const canMutate = panel.writable && !mutationPending;
    els["rules-add"].disabled = !canMutate;
    if (els["rules-add-empty"]) els["rules-add-empty"].disabled = !canMutate;
    els["rules-reset"].disabled = !canMutate;
    renderList();
    if (!editorOpen && !confirmOpen) setViewMode("list");
    void tryRestoreSessionDraft();
  }

  async function mutate(action, payload) {
    setControlsDisabled(true);
    setMessage(null);
    try {
      const response = await deps.send("rulesMutate", { action, ...payload });
      if (response.userMessage) {
        setMessage(response.userMessage, response.conflict ? "warn" : response.ok ? "ok" : "bad");
      }
      if (response.panel) renderPanel(response.panel);
      if (response.view) deps.onStatus({ ok: true, ...response.view });
      return response;
    } finally {
      setControlsDisabled(false);
      if (panel) renderList();
    }
  }

  function openEditor(rule, options = {}) {
    const { restore = false, fresh = false, stored = null } = options;
    if (stored) {
      editorMode = stored.mode;
      editingRuleId = stored.ruleId;
      applyFormFields(stored.fields);
      const liveRule = editorMode === "edit" && panel
        ? panel.rules.find((r) => r.id === stored.ruleId)
        : null;
      draft = liveRule ? { ...liveRule, ...stored.fields } : { id: stored.ruleId, ...stored.fields };
      els["rule-editor-title"].textContent =
        editorMode === "edit" ? "Редактировать правило" : "Новое правило";
      els["rule-form-error"].textContent = "";
      if (editorMode === "edit" && !liveRule) {
        setMessage(EDIT_RULE_MISSING_MSG, "warn");
      }
      setDeleteZoneVisible(editorMode === "edit" && Boolean(stored.ruleId));
      showEditorView();
      if (!restore) void persistDraftNow();
      return;
    }

    if (rule) {
      editorMode = "edit";
      editingRuleId = rule.id;
      draft = { ...rule };
      applyFormFields(rule);
      els["rule-editor-title"].textContent = "Редактировать правило";
    } else {
      editorMode = "create";
      editingRuleId = fresh ? generateRuleId() : (editingRuleId || generateRuleId());
      draft = null;
      applyFormFields({
        name: "",
        host: "",
        matchType: MatchType.DomainAndSubdomains,
        routeMode: RouteMode.VPN,
        enabled: true,
        notes: ""
      });
      els["rule-editor-title"].textContent = "Новое правило";
    }
    els["rule-form-error"].textContent = "";
    setDeleteZoneVisible(Boolean(rule && rule.id));
    showEditorView();
    void persistDraftNow();
  }

  async function tryRestoreSessionDraft() {
    if (sessionRestoreAttempted || editorOpen || confirmOpen) return;
    sessionRestoreAttempted = true;
    const stored = await draftStore.load();
    if (!stored || !panel || !panel.available || !panel.writable) return;
    openEditor(null, { restore: true, stored });
  }

  async function saveRule() {
    await flushPersistDraft();
    const built = buildUserRule(readFormFields(), editingRuleId);
    if (!built.ok) {
      els["rule-form-error"].textContent = built.message;
      return;
    }
    const response = await mutate("upsert", { rule: built.rule });
    if (response.ok) {
      await draftStore.clear();
      showListView();
    } else {
      if (response.userMessage && !response.conflict) {
        els["rule-form-error"].textContent = response.userMessage;
      }
    }
  }

  async function clearDraftIfMatchesRuleId(ruleId) {
    const stored = await draftStore.load();
    if (stored && stored.ruleId === ruleId) await draftStore.clear();
  }

  async function toggleRule(rule) {
    await mutate("upsert", { rule: prepareRuleForUpsert(rule, { enabled: !rule.enabled }) });
  }

  function openConfirmBar(text, action, ruleId) {
    confirmOpen = true;
    els["rules-confirm-text"].textContent = text;
    els["rules-confirm-bar"].dataset.action = action;
    els["rules-confirm-bar"].dataset.ruleId = ruleId || "";
    els["rules-confirm-bar"].hidden = false;
    els["rules-list-view"].hidden = true;
    els["rules-editor-view"].hidden = true;
    document.body.classList.remove("view-list", "view-editor");
    document.body.classList.add("view-confirm");
  }

  function closeConfirmBar() {
    confirmOpen = false;
    els["rules-confirm-bar"].hidden = true;
    if (editorOpen) showEditorView();
    else showListView();
  }

  function confirmDelete(rule) {
    openConfirmBar(
      "Удалить правило «" + rule.name + "» (" + formatRuleHostsLabel(rule) + ")?",
      "delete",
      rule.id
    );
  }

  function confirmReset() {
    openConfirmBar(
      "Удалить все правила Browser Routing? Маршрут по умолчанию станет Direct.",
      "reset",
      ""
    );
  }

  async function onConfirmOk() {
    const bar = els["rules-confirm-bar"];
    const action = bar.dataset.action;
    const ruleId = bar.dataset.ruleId;
    closeConfirmBar();
    if (action === "discard_draft_create") {
      await draftStore.clear();
      openEditor(null, { fresh: true });
      return;
    }
    if (action === "discard_draft_edit") {
      await draftStore.clear();
      const rule = pendingDiscardEditRule;
      pendingDiscardEditRule = null;
      if (rule) openEditor(rule, { fresh: true });
      return;
    }
    if (action === "delete") {
      const response = await mutate("delete", { id: ruleId });
      if (response.ok) {
        await clearDraftIfMatchesRuleId(ruleId);
        showListView();
      }
      return;
    }
    if (action === "reset") {
      const response = await mutate("reset", {});
      if (response.ok) await draftStore.clear();
      showListView();
    }
  }

  async function beginEditRule(rule) {
    if (!panel || !panel.writable || mutationPending) return;
    await flushPersistDraft();
    const stored = await draftStore.load();
    if (stored && draftHasUserContent(stored) &&
      (stored.mode !== "edit" || stored.ruleId !== rule.id)) {
      pendingDiscardEditRule = rule;
      openConfirmBar(
        "Заменить черновик и редактировать «" + rule.name + "»?",
        "discard_draft_edit",
        rule.id
      );
      return;
    }
    if (stored) await draftStore.clear();
    openEditor(rule, { fresh: true });
  }

  async function onAddClick() {
    if (!panel || !panel.writable || mutationPending) return;
    await flushPersistDraft();
    const stored = await draftStore.load();
    if (stored && draftHasUserContent(stored)) {
      openConfirmBar("Заменить черновик и начать новое правило?", "discard_draft_create", "");
      return;
    }
    if (stored) await draftStore.clear();
    openEditor(null, { fresh: true });
  }

  els["rules-add"].addEventListener("click", () => { void onAddClick(); });
  if (els["rules-add-empty"]) els["rules-add-empty"].addEventListener("click", () => { void onAddClick(); });
  els["rules-reset"].addEventListener("click", () => confirmReset());
  els["rule-save"].addEventListener("click", () => saveRule());
  els["rule-cancel"].addEventListener("click", () => cancelEditor());
  els["rule-back"].addEventListener("click", () => cancelEditor());

  for (const id of ["rule-name", "rule-host", "rule-notes"]) {
    els[id].addEventListener("input", schedulePersistDraft);
  }
  els["rule-match"].addEventListener("change", schedulePersistDraft);
  els["rule-enabled"].addEventListener("change", schedulePersistDraft);
  for (const input of els["rule-route-group"].querySelectorAll('input[name="rule-route"]')) {
    input.addEventListener("change", schedulePersistDraft);
  }
  els["rule-delete-edit"].addEventListener("click", () => {
    if (draft) confirmDelete(draft);
  });
  els["rules-confirm-ok"].addEventListener("click", () => onConfirmOk());
  els["rules-confirm-cancel"].addEventListener("click", () => closeConfirmBar());

  showListView();

  return Object.freeze({
    renderPanel,
    setMessage,
    getDraft: () => draft,
    isPending: () => mutationPending,
    isEditorOpen: () => editorOpen,
    tryRestoreSessionDraft,
    flushPersistDraft,
    buildDraftRecord
  });
}
