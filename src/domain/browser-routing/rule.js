import { Limits, MATCH_TYPES, ROUTE_MODES, RULE_SOURCES } from "./constants.js";
import { normalizeHost } from "./host.js";
import { IssueCode, hasOwn, isPlainObject, issue, pointer } from "./issues.js";

const REQUIRED_FIELDS = Object.freeze(["id", "name", "matchType", "routeMode", "enabled", "source"]);
const ALLOWED_FIELDS = Object.freeze(new Set([...REQUIRED_FIELDS, "hosts", "host", "notes"]));
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const NAME_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F]/u;
const NOTES_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

/**
 * Validates one rule and returns its canonical form.
 *
 * Canonical rules expose `hosts` (1+ normalized domains) and mirror `host` as `hosts[0]`
 * for backward-compatible JSON. Legacy persisted `host` migrates on read to `hosts`.
 *
 * @param {unknown} input
 * @param {string} [path] JSON Pointer of the rule, used in issues.
 */
export function validateRule(input, path = "") {
  const issues = [];
  if (!isPlainObject(input)) {
    issues.push(issue(IssueCode.InvalidType, path, "Rule must be a JSON object."));
    return result(null, issues);
  }

  for (const key of Object.keys(input).sort()) {
    if (!ALLOWED_FIELDS.has(key)) {
      issues.push(issue(IssueCode.UnknownField, pointer(path, key), "Unknown rule field."));
    }
  }

  for (const key of REQUIRED_FIELDS) {
    if (!hasOwn(input, key)) {
      issues.push(issue(IssueCode.MissingField, pointer(path, key), "Required rule field is missing."));
    }
  }

  const hasLegacyHost = hasOwn(input, "host");
  const hasHosts = hasOwn(input, "hosts");
  if (!hasLegacyHost && !hasHosts) {
    issues.push(issue(IssueCode.MissingField, pointer(path, "hosts"), "Required rule field is missing."));
  }

  const { id, name, matchType, routeMode, enabled, source } = input;
  const notes = hasOwn(input, "notes") ? input.notes : null;
  let canonicalHosts = null;

  if (hasHosts) {
    canonicalHosts = parseHostsField(input.hosts, path, issues);
  } else if (hasLegacyHost) {
    canonicalHosts = parseHostList([input.host], path, "host", issues);
  }

  if (hasLegacyHost && hasHosts && canonicalHosts) {
    const legacy = normalizeHost(input.host);
    if (!legacy.ok) {
      issues.push(issue(IssueCode.InvalidHost, pointer(path, "host"), legacy.error.message,
        { hostError: legacy.error.code }));
    } else if (legacy.host !== canonicalHosts[0]) {
      issues.push(issue(IssueCode.InvalidType, pointer(path, "hosts"),
        "host must match hosts[0] when both are present."));
    }
  }

  if (hasOwn(input, "id") &&
      (typeof id !== "string" || id.length === 0 || id.length > Limits.maxIdLength || !ID_PATTERN.test(id))) {
    issues.push(issue(IssueCode.InvalidId, pointer(path, "id"),
      "Rule id must be 1-64 characters of A-Z, a-z, 0-9, '_' or '-'."));
  }

  if (hasOwn(input, "name") &&
      (typeof name !== "string" || name.trim() === "" || name.length > Limits.maxNameLength ||
        NAME_FORBIDDEN.test(name))) {
    issues.push(issue(IssueCode.InvalidName, pointer(path, "name"),
      "Rule name must be a non-blank string up to 120 characters without control characters."));
  }

  if (hasOwn(input, "matchType") && !MATCH_TYPES.includes(matchType)) {
    issues.push(issue(IssueCode.UnknownMatchType, pointer(path, "matchType"),
      "matchType must be one of: " + MATCH_TYPES.join(", ") + "."));
  }

  if (hasOwn(input, "routeMode") && !ROUTE_MODES.includes(routeMode)) {
    issues.push(issue(IssueCode.UnknownRouteMode, pointer(path, "routeMode"),
      "routeMode must be one of: " + ROUTE_MODES.join(", ") + "."));
  }

  if (hasOwn(input, "enabled") && typeof enabled !== "boolean") {
    issues.push(issue(IssueCode.InvalidEnabled, pointer(path, "enabled"), "enabled must be a boolean."));
  }

  if (hasOwn(input, "source") && !RULE_SOURCES.includes(source)) {
    issues.push(issue(IssueCode.UnknownSource, pointer(path, "source"),
      "source must be one of: " + RULE_SOURCES.join(", ") + "."));
  }

  if (notes !== null &&
      (typeof notes !== "string" || notes.length > Limits.maxNotesLength || NOTES_FORBIDDEN.test(notes))) {
    issues.push(issue(IssueCode.InvalidNotes, pointer(path, "notes"),
      "notes must be null or a string up to 1000 characters; only tab and line breaks are allowed as control characters."));
  }

  if (issues.length > 0) {
    return result(null, issues);
  }

  return result(Object.freeze({
    id,
    name,
    hosts: canonicalHosts,
    host: canonicalHosts[0],
    matchType,
    routeMode,
    enabled,
    source,
    notes
  }), issues);
}

function parseHostsField(value, path, issues) {
  if (!Array.isArray(value)) {
    issues.push(issue(IssueCode.InvalidType, pointer(path, "hosts"), "hosts must be an array."));
    return null;
  }
  if (value.length === 0) {
    issues.push(issue(IssueCode.InvalidHost, pointer(path, "hosts"), "At least one host is required."));
    return null;
  }
  return parseHostList(value, path, "hosts", issues);
}

function parseHostList(entries, path, field, issues) {
  const canonical = [];
  const seen = new Set();
  for (let index = 0; index < entries.length; index++) {
    const entryPath = field === "hosts" ? pointer(path, field) + "/" + index : pointer(path, field);
    const raw = entries[index];
    const normalized = normalizeHost(raw);
    if (!normalized.ok) {
      issues.push(issue(IssueCode.InvalidHost, entryPath, normalized.error.message,
        { hostError: normalized.error.code }));
      continue;
    }
    if (!seen.has(normalized.host)) {
      seen.add(normalized.host);
      canonical.push(normalized.host);
    }
  }
  if (field === "hosts" && canonical.length === 0 &&
      !issues.some((entry) => entry.path === pointer(path, "hosts"))) {
    issues.push(issue(IssueCode.InvalidHost, pointer(path, "hosts"), "At least one host is required."));
  }
  return canonical.length > 0 ? Object.freeze(canonical) : null;
}

function result(rule, issues) {
  return Object.freeze({ ok: rule !== null, rule, issues: Object.freeze(issues) });
}
