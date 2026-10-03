export const IssueCode = Object.freeze({
  InvalidType: "invalid_type",
  MissingField: "missing_field",
  UnknownField: "unknown_field",
  InvalidId: "invalid_id",
  InvalidName: "invalid_name",
  InvalidHost: "invalid_host",
  UnknownMatchType: "unknown_match_type",
  UnknownRouteMode: "unknown_route_mode",
  InvalidEnabled: "invalid_enabled",
  UnknownSource: "unknown_source",
  InvalidNotes: "invalid_notes",
  DuplicateRuleId: "duplicate_rule_id",
  ConflictingRules: "conflicting_rules",
  TooManyRules: "too_many_rules",
  UnsupportedSchemaVersion: "unsupported_schema_version",
  InvalidRevision: "invalid_revision",
  InvalidDefaultRoute: "invalid_default_route"
});

/**
 * @param {string} code
 * @param {string} path JSON Pointer to the offending value.
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
export function issue(code, path, message, extra) {
  return Object.freeze(Object.assign({ code, path, message }, extra || {}));
}

/**
 * @param {string} base
 * @param {string | number} token
 */
export function pointer(base, token) {
  const escaped = String(token).replace(/~/g, "~0").replace(/\//g, "~1");
  return base + "/" + escaped;
}

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}
