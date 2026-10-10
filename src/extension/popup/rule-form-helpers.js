import { RuleSource } from "../../domain/browser-routing/constants.js";
import { normalizeHost } from "../../domain/browser-routing/host.js";

const ID_BODY = /^[a-z0-9]{12,32}$/;

export function generateRuleId() {
  const body = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return "rule-" + body;
}

/** @param {string} raw user input */
export function hostFromUserInput(raw) {
  let text = String(raw ?? "").trim();
  if (/^https?:\/\//i.test(text)) {
    try {
      text = new URL(text).hostname;
    } catch {
      /* keep literal for normalizeHost to reject */
    }
  } else if (text.startsWith("//")) {
    try {
      text = new URL("http:" + text).hostname;
    } catch {
      /* keep */
    }
  }
  return normalizeHost(text);
}

/** @param {string} raw multiline / comma-separated domain list */
export function hostsFromUserInput(raw) {
  const text = String(raw ?? "");
  const lines = text.split(/[\n,]+/);
  const hosts = [];
  const seen = new Set();
  let firstError = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const normalized = hostFromUserInput(trimmed);
    if (!normalized.ok) {
      if (!firstError) firstError = normalized;
      continue;
    }
    if (!seen.has(normalized.host)) {
      seen.add(normalized.host);
      hosts.push(normalized.host);
    }
  }
  if (hosts.length === 0) {
    if (firstError) {
      return { ok: false, message: firstError.error.message, field: "host" };
    }
    return { ok: false, message: "Укажите хотя бы один домен.", field: "host" };
  }
  return { ok: true, hosts: Object.freeze(hosts) };
}

export function buildUserRule(fields, existingId) {
  const id = existingId || generateRuleId();
  if (typeof id !== "string" || !/^rule-[a-z0-9_-]+$/.test(id)) {
    return { ok: false, message: "Некорректный идентификатор правила." };
  }
  const hostResult = hostsFromUserInput(fields.host);
  if (!hostResult.ok) {
    return { ok: false, message: hostResult.message, field: hostResult.field };
  }
  const name = String(fields.name ?? "").trim();
  if (!name) {
    return { ok: false, message: "Укажите название правила.", field: "name" };
  }
  return {
    ok: true,
    rule: Object.freeze({
      id,
      name,
      hosts: hostResult.hosts,
      host: hostResult.hosts[0],
      matchType: fields.matchType,
      routeMode: fields.routeMode,
      enabled: Boolean(fields.enabled),
      source: RuleSource.User,
      notes: fields.notes ? String(fields.notes) : null
    })
  };
}

export function isGeneratedRuleId(id) {
  return typeof id === "string" && id.startsWith("rule-") && ID_BODY.test(id.slice(5));
}
