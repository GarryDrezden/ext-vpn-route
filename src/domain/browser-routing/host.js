import { Limits } from "./constants.js";

export const HostError = Object.freeze({
  NotAString: "not_a_string",
  Empty: "empty",
  TooLong: "too_long",
  InvalidCharacter: "invalid_character",
  HasScheme: "has_scheme",
  HasUserinfo: "has_userinfo",
  HasPort: "has_port",
  HasPath: "has_path",
  HasQuery: "has_query",
  HasFragment: "has_fragment",
  Wildcard: "wildcard",
  IpLiteral: "ip_literal",
  EmptyLabel: "empty_label",
  LabelTooLong: "label_too_long",
  InvalidLabel: "invalid_label",
  InvalidIdn: "invalid_idn",
  Malformed: "malformed"
});

const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001F\u007F-\u009F]/u;
const NON_ASCII = /[^\u0000-\u007F]/u;
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/;
const DIGITS = /^[0-9]+$/;

function fail(code, message) {
  return Object.freeze({ ok: false, error: Object.freeze({ code, message }) });
}

function rejectStructure(value) {
  if (value.includes("://")) {
    return fail(HostError.HasScheme, "Host must not include a URL scheme.");
  }
  if (value.startsWith("[") || (value.match(/:/g) || []).length > 1) {
    return fail(HostError.IpLiteral, "IP address literals are not supported by domain rules.");
  }
  if (value.includes("@")) {
    return fail(HostError.HasUserinfo, "Host must not include user info.");
  }
  if (value.includes("*")) {
    return fail(HostError.Wildcard, "Wildcards are not supported. Use DomainAndSubdomains instead.");
  }
  if (value.includes("/") || value.includes("\\")) {
    return fail(HostError.HasPath, "Host must not include a path.");
  }
  if (value.includes("?")) {
    return fail(HostError.HasQuery, "Host must not include a query.");
  }
  if (value.includes("#")) {
    return fail(HostError.HasFragment, "Host must not include a fragment.");
  }
  if (value.includes(":")) {
    return /:[0-9]*$/.test(value)
      ? fail(HostError.HasPort, "Host must not include a port.")
      : fail(HostError.HasScheme, "Host must not include a URL scheme.");
  }
  if (value.includes("%")) {
    return fail(HostError.InvalidCharacter, "Percent-encoding is not allowed in a host.");
  }
  return null;
}

function toAscii(candidate) {
  try {
    return new URL("http://" + candidate + "/").hostname;
  } catch {
    return null;
  }
}

/**
 * Canonicalizes a domain host for routing rules and matching.
 *
 * Leading and trailing whitespace is trimmed. One trailing dot is removed.
 * Unicode labels are converted to Punycode with UTS #46 via the WHATWG URL host parser.
 *
 * @param {unknown} input
 * @returns {{ ok: true, host: string } | { ok: false, error: { code: string, message: string } }}
 */
export function normalizeHost(input) {
  if (typeof input !== "string") {
    return fail(HostError.NotAString, "Host must be a string.");
  }

  const trimmed = input.trim();
  if (trimmed === "") {
    return fail(HostError.Empty, "Host is empty.");
  }
  if (trimmed.length > Limits.maxHostInputLength) {
    return fail(HostError.TooLong, "Host is too long.");
  }
  if (WHITESPACE_OR_CONTROL.test(trimmed)) {
    return fail(HostError.InvalidCharacter, "Host must not contain whitespace or control characters.");
  }

  const structural = rejectStructure(trimmed);
  if (structural) return structural;

  const candidate = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (candidate === "" || candidate.startsWith(".") || candidate.endsWith(".") || candidate.includes("..")) {
    return fail(HostError.EmptyLabel, "Host has an empty label.");
  }

  const isUnicode = NON_ASCII.test(candidate);
  let ascii = toAscii(candidate);
  if (ascii === null) {
    return isUnicode
      ? fail(HostError.InvalidIdn, "Internationalized host cannot be converted to ASCII.")
      : fail(HostError.Malformed, "Host is malformed.");
  }

  if (ascii.endsWith(".")) {
    ascii = ascii.slice(0, -1);
  }
  if (ascii.startsWith("[")) {
    return fail(HostError.IpLiteral, "IP address literals are not supported by domain rules.");
  }
  if (NON_ASCII.test(ascii)) {
    return fail(HostError.InvalidIdn, "Internationalized host cannot be converted to ASCII.");
  }
  if (ascii.length > Limits.maxHostLength) {
    return fail(HostError.TooLong, "Host is longer than 253 characters.");
  }

  const labels = ascii.split(".");
  if (DIGITS.test(labels[labels.length - 1])) {
    return fail(HostError.IpLiteral, "IP address literals are not supported by domain rules.");
  }

  for (const label of labels) {
    if (label === "") {
      return fail(HostError.EmptyLabel, "Host has an empty label.");
    }
    if (label.length > Limits.maxLabelLength) {
      return fail(HostError.LabelTooLong, "Host label is longer than 63 characters.");
    }
    if (!LABEL.test(label) || label === "xn--") {
      return fail(HostError.InvalidLabel, "Host label contains characters that are not allowed.");
    }
  }

  return Object.freeze({ ok: true, host: ascii });
}

/**
 * @param {unknown} input
 * @returns {boolean}
 */
export function isCanonicalHost(input) {
  const result = normalizeHost(input);
  return result.ok && result.host === input;
}
