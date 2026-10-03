import { describe, test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  FORCED_LOCAL_POLICY,
  compilePacScript,
  isLoopbackProxyHost,
  jsStringLiteral
} from "../../src/pac/index.js";
import { domain, exact, mulberry32, shuffle, state } from "../domain/browser-routing/helpers.js";
import { DIRECT, PORT, VPN, codeOnly, compileOk, loadPac } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pacDir = path.join(root, "src/pac");
const pacDoc = readFileSync(path.join(root, "docs/pac-compiler-v1.md"), "utf8");

function sampleRules() {
  return [
    domain("youtube.com", "VPN", { id: "yt" }),
    domain("google.com", "VPN", { id: "g" }),
    exact("maps.google.com", "Default", { id: "maps" }),
    domain("cdn.google.com", "Direct", { id: "cdn" }),
    exact("ozon.ru", "Direct", { id: "ozon" }),
    domain("a.b.c.example.com", "VPN", { id: "deep" }),
    domain("off.test", "VPN", { id: "off", enabled: false })
  ];
}

describe("compiler options and proxy endpoint", () => {
  test("default host is 127.0.0.1 and port is required", () => {
    const result = compileOk(state([]), { proxyPort: PORT });
    assert.deepEqual(result.metadata.proxyEndpoint, { host: "127.0.0.1", port: PORT });
    assert.equal(result.metadata.proxyRoute, VPN);
    const missing = compilePacScript(state([]), {});
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "invalid_options");
    assert.deepEqual(missing.issues.map((i) => [i.code, i.path]), [["invalid_proxy_port", "/proxyPort"]]);
  });

  test("only IPv4 loopback hosts are accepted", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "127.255.255.254", "127.0.0.0"]) {
      assert.equal(isLoopbackProxyHost(host), true, host);
      assert.equal(compilePacScript(state([]), { proxyHost: host, proxyPort: PORT }).ok, true, host);
    }
    for (const host of ["localhost", "0.0.0.0", "10.0.0.1", "192.168.1.1", "8.8.8.8", "::1", "[::1]",
      "127.0.0.1:1080", "socks5://127.0.0.1", "127.0.0.1/", " 127.0.0.1", "127.0.0.1 ", "127.0.0.01",
      "127.0.0", "127.0.0.1.", "0x7f.0.0.1", "2130706433", "127.0.0.1; DIRECT", "127.0.0.1\"; x=\"",
      "127.0.0.1`calc`", "$(calc)", "", null, 127, {}, ["127.0.0.1"]]) {
      assert.equal(isLoopbackProxyHost(host), false, String(host));
      const result = compilePacScript(state([]), { proxyHost: host, proxyPort: PORT });
      assert.equal(result.ok, false, String(host));
      assert.deepEqual(result.issues.map((i) => i.code), ["invalid_proxy_host"], String(host));
    }
  });

  test("port must be an integer from 1 to 65535", () => {
    for (const port of [1, 1080, 17891, 65535]) {
      assert.equal(compilePacScript(state([]), { proxyPort: port }).ok, true, String(port));
    }
    for (const port of [0, -1, 65536, 1.5, NaN, Infinity, "17891", null, undefined, true, [17891]]) {
      const result = compilePacScript(state([]), { proxyPort: port });
      assert.equal(result.ok, false, String(port));
      assert.deepEqual(result.issues.map((i) => i.code), ["invalid_proxy_port"], String(port));
    }
  });

  test("options must be a plain object without unknown keys", () => {
    for (const options of [undefined, null, 17891, "127.0.0.1:17891", [], new Map()]) {
      const result = compilePacScript(state([]), options);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "invalid_options");
      assert.equal(result.script, undefined);
    }
    const extra = compilePacScript(state([]), { proxyPort: PORT, fallback: "DIRECT", proxyScheme: "HTTPS" });
    assert.equal(extra.ok, false);
    assert.deepEqual(extra.issues.map((i) => [i.code, i.path]), [["unknown_option", "/fallback"], ["unknown_option", "/proxyScheme"]]);
  });
});

describe("compiler rejects invalid state", () => {
  test("invalid or ambiguous states produce no script", () => {
    const cases = [
      null,
      {},
      state([], { schemaVersion: 2 }),
      state([], { defaultRoute: "Default" }),
      state([], { revision: -1 }),
      state([exact("https://example.com", "VPN")]),
      state([domain("example.com", "VPN"), domain("EXAMPLE.com.", "Direct")]),
      state([exact("a.com", "VPN", { id: "x" }), exact("b.com", "VPN", { id: "x" })]),
      Object.assign(state([]), { fallback: "DIRECT" })
    ];
    for (const input of cases) {
      const result = compilePacScript(input, { proxyPort: PORT });
      assert.equal(result.ok, false, JSON.stringify(input));
      assert.equal(result.error.code, "invalid_state");
      assert.ok(result.issues.length > 0);
      assert.equal("script" in result, false);
    }
  });

  test("invalid options are reported before state is examined", () => {
    const result = compilePacScript(null, { proxyPort: 0 });
    assert.equal(result.error.code, "invalid_options");
  });

  test("result objects are frozen", () => {
    const ok = compileOk(state(sampleRules()));
    assert.ok(Object.isFrozen(ok) && Object.isFrozen(ok.metadata) && Object.isFrozen(ok.metadata.proxyEndpoint));
    const bad = compilePacScript(null, { proxyPort: PORT });
    assert.ok(Object.isFrozen(bad) && Object.isFrozen(bad.issues));
  });
});

describe("compiler metadata", () => {
  test("counts rules and reports the endpoint", () => {
    const result = compileOk(state(sampleRules(), { revision: 42, defaultRoute: "VPN" }));
    assert.deepEqual({ ...result.metadata, proxyEndpoint: { ...result.metadata.proxyEndpoint } }, {
      pacFormatVersion: 1,
      schemaVersion: 1,
      revision: 42,
      defaultRoute: "VPN",
      proxyEndpoint: { host: "127.0.0.1", port: PORT },
      proxyRoute: VPN,
      ruleCount: 7,
      enabledRuleCount: 6,
      exactRuleCount: 2,
      domainRuleCount: 4,
      byteLength: result.script.length
    });
  });

  test("revision is in the header and nowhere in routing", () => {
    const a = compileOk(state(sampleRules(), { revision: 42 })).script;
    const b = compileOk(state(sampleRules(), { revision: 43 })).script;
    assert.ok(a.includes("// BrowserRoutingState schemaVersion: 1, revision: 42\n"));
    const strip = (script) => script.replace(/^\/\/ BrowserRoutingState .*$/m, "");
    assert.equal(strip(a), strip(b));
  });
});

describe("deterministic output", () => {
  test("repeated compile is byte-identical", () => {
    const s = state(sampleRules());
    const first = compileOk(s).script;
    for (let i = 0; i < 5; i++) assert.equal(compileOk(s).script, first);
  });

  test("shuffled rules produce a byte-identical PAC", () => {
    const random = mulberry32(7);
    const rules = sampleRules();
    const expected = compileOk(state(rules)).script;
    for (let i = 0; i < 200; i++) {
      assert.equal(compileOk(state(shuffle(random, rules))).script, expected);
    }
  });

  test("display fields, ids, sources and disabled rules do not change the PAC", () => {
    const base = compileOk(state(sampleRules())).script;
    const relabeled = sampleRules().map((rule, index) => ({
      ...rule, id: "other-" + index, name: "Renamed " + index, notes: "changed", source: "System"
    }));
    relabeled.push(exact("disabled.example", "VPN", { enabled: false }));
    assert.equal(compileOk(state(relabeled)).script, base);
  });

  test("equivalent non-canonical rule hosts produce the canonical PAC", () => {
    const canonical = compileOk(state([domain("youtube.com", "VPN"), exact("xn--e1afmkfd.xn--p1ai", "Direct")])).script;
    const spelled = compileOk(state([domain(" YouTube.COM. ", "VPN"), exact("пример.рф", "Direct")])).script;
    assert.equal(spelled, canonical);
  });

  test("route table order follows matcher precedence", () => {
    const script = compileOk(state(sampleRules())).script;
    const keys = [...script.matchAll(/^"([ed]:[^"]+)": [01],?$/gm)].map((m) => m[1]);
    assert.deepEqual(keys, [
      "e:maps.google.com", "e:ozon.ru",
      "d:a.b.c.example.com", "d:cdn.google.com", "d:google.com", "d:youtube.com"
    ]);
  });

  test("Default rules are resolved to the state's defaultRoute at compile time", () => {
    const direct = compileOk(state([exact("maps.google.com", "Default")], { defaultRoute: "Direct" })).script;
    const vpn = compileOk(state([exact("maps.google.com", "Default")], { defaultRoute: "VPN" })).script;
    assert.ok(direct.includes("\"e:maps.google.com\": 0"));
    assert.ok(vpn.includes("\"e:maps.google.com\": 1"));
    assert.ok(direct.includes("var VR_DEFAULT = VR_DIRECT;"));
    assert.ok(vpn.includes("var VR_DEFAULT = VR_VPN;"));
  });
});

describe("generated source integrity", () => {
  const hostile = [
    exact("constructor", "VPN", { id: "ID_SECRET_1", name: "NAME_SECRET \"; return \"DIRECT\"; //", notes: "NOTES_SECRET </script>\u2028" }),
    domain("__proto__", "Direct", { id: "ID_SECRET_2", name: "NAME_SECRET_2 \\ ' `${x}`" }),
    domain("alert", "VPN"), domain("eval", "VPN"), domain("fetch", "VPN"), domain("dnsresolve", "VPN"),
    domain("xn--e1afmkfd.xn--p1ai", "VPN")
  ];

  test("PAC never contains ids, names or notes", () => {
    const script = compileOk(state(hostile)).script;
    for (const secret of ["ID_SECRET", "NAME_SECRET", "NOTES_SECRET", "</script>", "\u2028", "`"]) {
      assert.equal(script.includes(secret), false, secret);
    }
  });

  test("PAC parses as a script, is ASCII and defines FindProxyForURL", () => {
    for (const rules of [[], sampleRules(), hostile]) {
      for (const defaultRoute of ["VPN", "Direct"]) {
        const script = compileOk(state(rules, { defaultRoute })).script;
        assert.doesNotThrow(() => new vm.Script(script));
        assert.match(script, /^[\x00-\x7f]*$/);
        assert.match(script, /\nfunction FindProxyForURL\(url, host\) \{\n/);
        assert.equal(loadPac(script).find("constructor"), defaultRoute === "VPN" || rules === hostile ? VPN : DIRECT);
      }
    }
  });

  test("jsStringLiteral round-trips hostile strings as ASCII", () => {
    for (const value of ["", "plain", "\"", "\\", "'", "`${a}`", "</script>", "\n\r\t\0", "\u2028\u2029",
      "\u007f", "пример", "\uD83D\uDE00", "\uD800", "*/ x /*"]) {
      const literal = jsStringLiteral(value);
      assert.match(literal, /^"[\x20-\x7e]*"$/, JSON.stringify(value));
      assert.equal(vm.runInNewContext(literal), value);
    }
    assert.throws(() => jsStringLiteral(1), TypeError);
  });

  test("VPN route literal never carries a DIRECT fallback", () => {
    const script = compileOk(state(sampleRules(), { defaultRoute: "VPN" })).script;
    assert.equal(/SOCKS5[^"\n]*;/.test(script), false);
    assert.equal(script.includes("; DIRECT"), false);
    assert.equal([...script.matchAll(/"SOCKS5 /g)].length, 1);
    assert.equal([...script.matchAll(/"DIRECT"/g)].length, 1);
  });
});

describe("generated PAC security scan", () => {
  const scripts = [[], sampleRules()].flatMap((rules) =>
    ["VPN", "Direct"].map((defaultRoute) => compileOk(state(rules, { defaultRoute })).script));

  test("no DNS, network or PAC helper calls", () => {
    const forbidden = [
      "dnsResolve", "dnsResolveEx", "isResolvable", "isResolvableEx", "isInNet", "isInNetEx",
      "myIpAddress", "myIpAddressEx", "sortIpAddressList", "isPlainHostName", "dnsDomainIs",
      "localHostOrDomainIs", "dnsDomainLevels", "shExpMatch", "alert", "fetch", "XMLHttpRequest",
      "WebSocket", "importScripts", "navigator", "eval", "Function", "setTimeout", "setInterval",
      "console", "Date", "Math", "require", "process", "globalThis", "window", "self", "this"
    ];
    for (const script of scripts) {
      const code = codeOnly(script);
      for (const name of forbidden) {
        assert.equal(new RegExp("\\b" + name + "\\b").test(code), false, name);
      }
    }
  });

  test("ES5-only syntax and globals", () => {
    const forbidden = [
      /=>/, /\blet\b/, /\bconst\b/, /\bclass\b/, /`/, /\.\.\./, /\?\./, /\?\?/, /\basync\b/, /\bawait\b/,
      /\byield\b/, /\bimport\b/, /\bexport\b/, /\bPromise\b/, /\bMap\b/, /\bSet\b/, /\bWeakMap\b/,
      /\bSymbol\b/, /\bProxy\b/, /\bReflect\b/, /\bURL\b/, /\bBigInt\b/, /\bnew\b/, /\.includes\(/,
      /\.startsWith\(/, /\.endsWith\(/, /\.padStart\(/, /Object\.create/, /Object\.assign/, /\/[gimsuy]*[suy][gimsuy]*;/
    ];
    for (const script of scripts) {
      const code = codeOnly(script);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(code), false, String(pattern));
      }
    }
  });

  test("no logging and no mutable state between calls", () => {
    for (const script of scripts) {
      const code = codeOnly(script);
      assert.equal(/\bconsole\b|\balert\b/.test(code), false);
      assert.equal(/\bVR_[A-Z_]+\s*=(?!=)/.test(code.split("function FindProxyForURL")[1]), false);
    }
  });
});

describe("PAC module boundary and documentation", () => {
  const files = readdirSync(pacDir).filter((name) => name.endsWith(".js"));

  test("compiler sources do not use browser, Node or network APIs", () => {
    const forbidden = [
      /\bchrome\./, /\bbrowser\./, /\bdocument\./, /\bwindow\./, /\bglobalThis\./, /\blocalStorage\b/,
      /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bprocess\./, /\brequire\s*\(/, /from\s+["']node:/,
      /import\s*\(/, /\bDate\b/, /Math\.random/, /\bsetTimeout\b/, /\beval\s*\(/, /new\s+Function/, /\bBuffer\b/
    ];
    assert.ok(files.length >= 5);
    for (const name of files) {
      const source = readFileSync(path.join(pacDir, name), "utf8");
      for (const pattern of forbidden) {
        assert.equal(pattern.test(source), false, `${name} matches ${pattern}`);
      }
    }
  });

  test("compiler imports only its own modules and the domain layer", () => {
    for (const name of files) {
      const source = readFileSync(path.join(pacDir, name), "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        assert.ok(match[1].startsWith("./") || match[1].startsWith("../domain/browser-routing/"), `${name} imports ${match[1]}`);
      }
    }
  });

  test("documentation lists every forced-local range", () => {
    for (const entry of [...FORCED_LOCAL_POLICY.ipv4, ...FORCED_LOCAL_POLICY.ipv6, FORCED_LOCAL_POLICY.ipv4MappedIpv6,
      "100.64.0.0/10", "localhost", "*.localhost"]) {
      assert.ok(pacDoc.includes("`" + entry + "`"), entry);
    }
  });
});

describe("large states", () => {
  test("10000 rules compile and route correctly", () => {
    const rules = [];
    for (let i = 0; i < 10000; i++) {
      const host = "site" + i + ".zone" + (i % 97) + ".example";
      rules.push(i % 3 === 0 ? exact(host, "Direct") : domain(host, i % 2 ? "VPN" : "Default"));
    }
    const result = compileOk(state(rules, { defaultRoute: "VPN" }));
    assert.equal(result.metadata.enabledRuleCount, 10000);
    const pac = loadPac(result.script);
    assert.equal(pac.find("site0.zone0.example"), DIRECT);
    assert.equal(pac.find("www.site1.zone1.example"), VPN);
    assert.equal(pac.find("www.site3.zone3.example"), VPN);
    assert.equal(pac.find("site9999.zone8.example"), DIRECT);
    assert.equal(pac.find("unknown.example"), VPN);
  });
});
