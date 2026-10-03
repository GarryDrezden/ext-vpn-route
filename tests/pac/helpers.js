import vm from "node:vm";
import assert from "node:assert/strict";
import { compilePacScript } from "../../src/pac/index.js";

export const PORT = 17891;
export const VPN = "SOCKS5 127.0.0.1:" + PORT;
export const DIRECT = "DIRECT";

export const FORBIDDEN_GLOBALS = Object.freeze([
  "dnsResolve", "dnsResolveEx", "isResolvable", "isResolvableEx", "isInNet", "isInNetEx",
  "myIpAddress", "myIpAddressEx", "sortIpAddressList", "getClientVersion", "isPlainHostName",
  "dnsDomainIs", "localHostOrDomainIs", "dnsDomainLevels", "shExpMatch", "weekdayRange",
  "dateRange", "timeRange", "alert", "fetch", "XMLHttpRequest", "WebSocket", "require",
  "process", "console", "setTimeout", "eval", "Function"
]);

const CALL = new vm.Script("FindProxyForURL(__vrUrl, __vrHost)");
const BATCH = new vm.Script(
  "(function (hosts) { var out = []; for (var i = 0; i < hosts.length; i++) " +
  "out.push(FindProxyForURL(\"https://\" + hosts[i] + \"/\", hosts[i])); return out; })(__vrHosts)");

/**
 * Runs a PAC in an isolated context. Any read of a PAC helper, DNS function or network API
 * from the generated code is recorded and throws, so the calling test fails.
 */
export function loadPac(script) {
  const touched = [];
  const sandbox = {};
  for (const name of FORBIDDEN_GLOBALS) {
    Object.defineProperty(sandbox, name, {
      get() {
        touched.push(name);
        throw new Error("PAC accessed forbidden global " + name);
      }
    });
  }
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(script, context, { filename: "generated.pac", timeout: 2000 });
  assert.equal(typeof context.FindProxyForURL, "function");

  function find(host, url) {
    context.__vrHost = host;
    context.__vrUrl = url === undefined ? "https://" + host + "/" : url;
    const result = CALL.runInContext(context, { timeout: 1000 });
    assert.deepEqual(touched, [], "generated PAC touched forbidden globals");
    return result;
  }

  function findMany(hosts) {
    context.__vrHosts = hosts;
    const results = BATCH.runInContext(context, { timeout: 5000 });
    assert.deepEqual(touched, [], "generated PAC touched forbidden globals");
    return Array.from(results);
  }

  return { find, findMany, touched };
}

export function compileOk(state, options = { proxyPort: PORT }) {
  const result = compilePacScript(state, options);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  return result;
}

export function pacFor(state, options) {
  return loadPac(compileOk(state, options).script);
}

export function toPacRoute(effectiveRoute) {
  if (effectiveRoute === "VPN") return VPN;
  if (effectiveRoute === "Direct") return DIRECT;
  throw new Error("Unexpected effective route " + effectiveRoute);
}

/** Removes comment lines and string literals so static scans see only code, not routing data. */
export function codeOnly(script) {
  return script
    .replace(/^\/\/.*$/gm, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, "\"\"");
}
