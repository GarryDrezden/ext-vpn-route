import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HostError, isCanonicalHost, normalizeHost } from "../../../src/domain/browser-routing/index.js";

function ok(input, expected) {
  const result = normalizeHost(input);
  assert.equal(result.ok, true, `${JSON.stringify(input)} should be valid: ${JSON.stringify(result)}`);
  assert.equal(result.host, expected);
}

function rejects(input, code) {
  const result = normalizeHost(input);
  assert.equal(result.ok, false, `${JSON.stringify(input)} should be rejected`);
  assert.equal(result.error.code, code, `${JSON.stringify(input)}: ${result.error.code}`);
  assert.equal(typeof result.error.message, "string");
}

describe("normalizeHost: canonical forms", () => {
  test("lowercases ASCII", () => {
    ok("WWW.Example.COM", "www.example.com");
  });

  test("removes one trailing dot", () => {
    ok("example.com.", "example.com");
    ok("Example.COM.", "example.com");
  });

  test("trims leading and trailing whitespace before validation", () => {
    ok("  example.com  ", "example.com");
    ok("\texample.com\n", "example.com");
    ok("\u00A0example.com\u00A0", "example.com");
  });

  test("Unicode labels become Punycode", () => {
    ok("пример.рф", "xn--e1afmkfd.xn--p1ai");
    ok("ПРИМЕР.РФ", "xn--e1afmkfd.xn--p1ai");
    ok("госуслуги.рф", "xn--c1aapkosapc.xn--p1ai");
    ok("münchen.de", "xn--mnchen-3ya.de");
  });

  test("Punycode input is accepted and lowercased", () => {
    ok("XN--E1AFMKFD.XN--P1AI", "xn--e1afmkfd.xn--p1ai");
  });

  test("UTS46 maps fullwidth characters", () => {
    ok("ｅｘａｍｐｌｅ.com", "example.com");
  });

  test("allows single-label, hyphenated and underscore labels", () => {
    ok("intranet", "intranet");
    ok("my-site.example.com", "my-site.example.com");
    ok("foo_bar.example.com", "foo_bar.example.com");
    ok("123abc.example.com", "123abc.example.com");
  });

  test("accepts maximum label and host lengths", () => {
    const label63 = "a".repeat(63);
    ok(label63 + ".com", label63 + ".com");
    const host253 = [ "a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61) ].join(".");
    assert.equal(host253.length, 253);
    ok(host253, host253);
  });

  test("is idempotent", () => {
    for (const input of ["WWW.Example.COM.", "пример.рф", " münchen.de ", "foo_bar.example.com"]) {
      const once = normalizeHost(input);
      assert.equal(once.ok, true);
      assert.equal(normalizeHost(once.host).host, once.host);
      assert.equal(isCanonicalHost(once.host), true);
    }
  });

  test("isCanonicalHost is false for non-canonical forms", () => {
    assert.equal(isCanonicalHost("Example.com"), false);
    assert.equal(isCanonicalHost("example.com."), false);
    assert.equal(isCanonicalHost(" example.com"), false);
    assert.equal(isCanonicalHost("пример.рф"), false);
    assert.equal(isCanonicalHost("example.com"), true);
  });
});

describe("normalizeHost: rejected input", () => {
  test("non-string and empty", () => {
    rejects(undefined, HostError.NotAString);
    rejects(null, HostError.NotAString);
    rejects(42, HostError.NotAString);
    rejects("", HostError.Empty);
    rejects("   ", HostError.Empty);
    rejects("\t\n", HostError.Empty);
  });

  test("whitespace and control characters inside", () => {
    rejects("exa mple.com", HostError.InvalidCharacter);
    rejects("example.com\u0000", HostError.InvalidCharacter);
    rejects("exam\tple.com", HostError.InvalidCharacter);
    rejects("exam\u00A0ple.com", HostError.InvalidCharacter);
  });

  test("scheme", () => {
    rejects("https://example.com", HostError.HasScheme);
    rejects("http://example.com/", HostError.HasScheme);
    rejects("mailto:example.com", HostError.HasScheme);
  });

  test("path, query, fragment, userinfo", () => {
    rejects("example.com/foo", HostError.HasPath);
    rejects("example.com\\foo", HostError.HasPath);
    rejects("example.com?q=1", HostError.HasQuery);
    rejects("example.com#top", HostError.HasFragment);
    rejects("user@example.com", HostError.HasUserinfo);
  });

  test("port", () => {
    rejects("example.com:443", HostError.HasPort);
    rejects("example.com:", HostError.HasPort);
  });

  test("wildcards", () => {
    rejects("*.example.com", HostError.Wildcard);
    rejects("*example.com", HostError.Wildcard);
    rejects("www.*.com", HostError.Wildcard);
  });

  test("IP literals", () => {
    rejects("1.2.3.4", HostError.IpLiteral);
    rejects("127.0.0.1", HostError.IpLiteral);
    rejects("1.2.3.4.", HostError.IpLiteral);
    rejects("0x7f.1", HostError.IpLiteral);
    rejects("2130706433", HostError.IpLiteral);
    rejects("[::1]", HostError.IpLiteral);
    rejects("::1", HostError.IpLiteral);
    rejects("2001:db8::1", HostError.IpLiteral);
  });

  test("empty labels", () => {
    rejects(".", HostError.EmptyLabel);
    rejects("..", HostError.EmptyLabel);
    rejects(".example.com", HostError.EmptyLabel);
    rejects("example..com", HostError.EmptyLabel);
    rejects("example.com..", HostError.EmptyLabel);
  });

  test("malformed labels", () => {
    rejects("-example.com", HostError.InvalidLabel);
    rejects("example-.com", HostError.InvalidLabel);
    rejects("exa!mple.com", HostError.InvalidLabel);
    rejects("exa$mple.com", HostError.InvalidLabel);
    rejects("example%2ecom", HostError.InvalidCharacter);
  });

  test("invalid Punycode labels", () => {
    for (const input of ["xn--.com", "xn--a.com"]) {
      const result = normalizeHost(input);
      assert.equal(result.ok, false, input);
      assert.ok([HostError.Malformed, HostError.InvalidLabel].includes(result.error.code), input);
    }
  });

  test("forbidden host code points rejected by the URL host parser", () => {
    rejects("exa<mple.com", HostError.Malformed);
    rejects("exa|mple.com", HostError.Malformed);
  });

  test("last label must not be numeric", () => {
    const result = normalizeHost("example.123");
    assert.equal(result.ok, false);
    assert.ok([HostError.IpLiteral, HostError.Malformed].includes(result.error.code), result.error.code);
  });

  test("length limits", () => {
    rejects("a".repeat(64) + ".com", HostError.LabelTooLong);
    const host254 = [ "a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(62) ].join(".");
    assert.equal(host254.length, 254);
    rejects(host254, HostError.TooLong);
    rejects("a".repeat(2000), HostError.TooLong);
  });
});
