import { MatchType, RouteMode } from "../../domain/browser-routing/constants.js";
import { isGeneratedRuleId } from "./rule-form-helpers.js";

export const RULE_EDITOR_DRAFT_KEY = "browserRoutingRuleEditorDraft";
export const RULE_EDITOR_DRAFT_VERSION = 1;

const VALID_MODES = new Set(["create", "edit"]);
const VALID_MATCH = new Set(Object.values(MatchType));
const VALID_ROUTE = new Set(Object.values(RouteMode));

/**
 * @param {unknown} record
 * @returns {boolean}
 */
export function draftHasUserContent(record) {
  if (!record || !record.fields) return false;
  const f = record.fields;
  if (String(f.name ?? "").trim()) return true;
  if (String(f.host ?? "").trim()) return true;
  if (String(f.notes ?? "").trim()) return true;
  return false;
}

/**
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeDraftRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const mode = raw.mode;
  if (!VALID_MODES.has(mode)) return null;
  const ruleId = raw.ruleId;
  if (ruleId !== null && (typeof ruleId !== "string" || !/^rule-[a-z0-9_-]+$/.test(ruleId))) return null;
  if (mode === "edit" && !ruleId) return null;
  if (mode === "create") {
    if (!ruleId || !isGeneratedRuleId(ruleId)) return null;
  }
  const fields = raw.fields;
  if (!fields || typeof fields !== "object") return null;
  const matchType = fields.matchType;
  const routeMode = fields.routeMode;
  if (!VALID_MATCH.has(matchType) || !VALID_ROUTE.has(routeMode)) return null;
  return Object.freeze({
    version: RULE_EDITOR_DRAFT_VERSION,
    mode,
    ruleId: ruleId ?? null,
    fields: Object.freeze({
      name: String(fields.name ?? ""),
      host: String(fields.host ?? ""),
      matchType,
      routeMode,
      enabled: Boolean(fields.enabled),
      notes: String(fields.notes ?? "")
    }),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now()
  });
}

/**
 * @param {{
 *   get: (keys: string | string[]) => Promise<Record<string, unknown>>,
 *   set: (items: Record<string, unknown>) => Promise<void>,
 *   remove: (keys: string | string[]) => Promise<void>
 * }} session
 */
export function createRuleEditorDraftStore(session) {
  return Object.freeze({
    storageArea: "session",
    key: RULE_EDITOR_DRAFT_KEY,
    async load() {
      const bag = await session.get(RULE_EDITOR_DRAFT_KEY);
      return normalizeDraftRecord(bag[RULE_EDITOR_DRAFT_KEY]);
    },
    async save(record) {
      const normalized = normalizeDraftRecord(record);
      if (!normalized) return;
      await session.set({
        [RULE_EDITOR_DRAFT_KEY]: { ...normalized, updatedAt: Date.now() }
      });
    },
    async clear() {
      await session.remove(RULE_EDITOR_DRAFT_KEY);
    }
  });
}

export function createChromeSessionDraftStore() {
  const session = chrome.storage.session;
  return createRuleEditorDraftStore({
    get: (keys) => new Promise((resolve) => session.get(keys, resolve)),
    set: (items) => new Promise((resolve) => session.set(items, resolve)),
    remove: (keys) => new Promise((resolve) => session.remove(keys, resolve))
  });
}

/** @returns {ReturnType<typeof createRuleEditorDraftStore>} */
export function createMemoryDraftStore() {
  let value = null;
  const bag = () => ({ [RULE_EDITOR_DRAFT_KEY]: value });
  return createRuleEditorDraftStore({
    get: async () => bag(),
    set: async (items) => { value = items[RULE_EDITOR_DRAFT_KEY] ?? null; },
    remove: async () => { value = null; }
  });
}
