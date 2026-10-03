import { DEFAULT_ROUTES, Limits, SCHEMA_VERSION } from "./constants.js";
import { IssueCode, hasOwn, isPlainObject, issue, pointer } from "./issues.js";
import { validateRule } from "./rule.js";

const STATE_FIELDS = Object.freeze(["schemaVersion", "revision", "defaultRoute", "rules"]);
const STATE_FIELD_SET = Object.freeze(new Set(STATE_FIELDS));

/**
 * Validates a rule list: every rule on its own, unique ids, and no ambiguous enabled rules.
 *
 * Two enabled rules with the same canonical host and matchType conflict, whatever their routeMode.
 * Disabled rules are still fully validated and must have unique ids, but never conflict.
 *
 * @param {unknown} rules
 * @param {string} [path] JSON Pointer of the rule array.
 */
export function validateRuleSet(rules, path = "/rules") {
  const issues = [];
  if (!Array.isArray(rules)) {
    issues.push(issue(IssueCode.InvalidType, path, "rules must be an array."));
    return result(null, issues);
  }
  if (rules.length > Limits.maxRules) {
    issues.push(issue(IssueCode.TooManyRules, path, "At most " + Limits.maxRules + " rules are allowed."));
    return result(null, issues);
  }

  const canonical = [];
  const idPaths = new Map();
  const activeKeys = new Map();

  rules.forEach((input, index) => {
    const rulePath = pointer(path, index);
    const validated = validateRule(input, rulePath);
    issues.push(...validated.issues);

    if (isPlainObject(input) && typeof input.id === "string") {
      const seen = idPaths.get(input.id);
      if (seen) {
        issues.push(issue(IssueCode.DuplicateRuleId, pointer(rulePath, "id"), "Rule id is already used.",
          { ruleId: input.id, firstPath: seen }));
      } else {
        idPaths.set(input.id, pointer(rulePath, "id"));
      }
    }

    if (!validated.ok) return;
    const rule = validated.rule;
    canonical.push(rule);
    if (!rule.enabled) return;

    const key = rule.matchType + " " + rule.host;
    const group = activeKeys.get(key);
    if (group) {
      group.push({ id: rule.id, path: rulePath });
    } else {
      activeKeys.set(key, [{ id: rule.id, path: rulePath }]);
    }
  });

  const conflictKeys = [...activeKeys.keys()].filter((key) => activeKeys.get(key).length > 1).sort();
  for (const key of conflictKeys) {
    const group = activeKeys.get(key);
    const [matchType, host] = key.split(" ");
    issues.push(issue(IssueCode.ConflictingRules, path,
      "Enabled rules share the same host and matchType; the rule set is ambiguous.",
      {
        host,
        matchType,
        ruleIds: Object.freeze(group.map((entry) => entry.id).sort()),
        paths: Object.freeze(group.map((entry) => entry.path))
      }));
  }

  return result(issues.length === 0 ? Object.freeze(canonical) : null, issues);
}

/**
 * Validates a BrowserRoutingStateV1 document and returns its canonical, frozen copy.
 * The input object is never modified.
 *
 * @param {unknown} input
 */
export function validateBrowserRoutingState(input) {
  const issues = [];
  if (!isPlainObject(input)) {
    issues.push(issue(IssueCode.InvalidType, "", "State must be a JSON object."));
    return stateResult(null, issues);
  }

  for (const key of Object.keys(input).sort()) {
    if (!STATE_FIELD_SET.has(key)) {
      issues.push(issue(IssueCode.UnknownField, pointer("", key), "Unknown state field."));
    }
  }
  for (const key of STATE_FIELDS) {
    if (!hasOwn(input, key)) {
      issues.push(issue(IssueCode.MissingField, pointer("", key), "Required state field is missing."));
    }
  }

  const { schemaVersion, revision, defaultRoute, rules } = input;

  if (hasOwn(input, "schemaVersion") && schemaVersion !== SCHEMA_VERSION) {
    issues.push(issue(IssueCode.UnsupportedSchemaVersion, "/schemaVersion",
      "schemaVersion must be " + SCHEMA_VERSION + "."));
  }

  if (hasOwn(input, "revision") && !(Number.isSafeInteger(revision) && revision >= 0)) {
    issues.push(issue(IssueCode.InvalidRevision, "/revision",
      "revision must be an integer from 0 to 2^53-1."));
  }

  if (hasOwn(input, "defaultRoute") && !DEFAULT_ROUTES.includes(defaultRoute)) {
    issues.push(issue(IssueCode.InvalidDefaultRoute, "/defaultRoute",
      "defaultRoute must be one of: " + DEFAULT_ROUTES.join(", ") + ". Default is only valid on rules."));
  }

  let canonicalRules = null;
  if (hasOwn(input, "rules")) {
    const ruleSet = validateRuleSet(rules, "/rules");
    issues.push(...ruleSet.issues);
    canonicalRules = ruleSet.rules;
  }

  if (issues.length > 0) {
    return stateResult(null, issues);
  }

  return stateResult(Object.freeze({
    schemaVersion,
    revision,
    defaultRoute,
    rules: canonicalRules
  }), issues);
}

function result(rules, issues) {
  return Object.freeze({ ok: rules !== null, rules, issues: Object.freeze(issues) });
}

function stateResult(state, issues) {
  return Object.freeze({ ok: state !== null, state, issues: Object.freeze(issues) });
}
