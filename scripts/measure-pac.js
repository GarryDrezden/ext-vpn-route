// Measures generated PAC size, compile time and lookup time in a Node vm context.
// Numbers are indicative only: Chromium runs PAC in its own V8 isolate.
import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { compilePacScript } from "../src/pac/index.js";

function makeState(count) {
  const rules = [];
  for (let i = 0; i < count; i++) {
    const host = "site" + i + ".zone" + (i % 97) + ".example";
    rules.push({
      id: "r" + i,
      name: "Rule " + i,
      host,
      matchType: i % 3 === 0 ? "ExactHost" : "DomainAndSubdomains",
      routeMode: i % 2 ? "VPN" : "Direct",
      enabled: true,
      source: "User",
      notes: null
    });
  }
  return { schemaVersion: 1, revision: 1, defaultRoute: "VPN", rules };
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const LOOKUPS = 200000;
const rows = [];
for (const count of [0, 100, 1000, 10000]) {
  const state = makeState(count);
  const options = { proxyPort: 17891 };
  let result;
  const compileTimes = [];
  for (let i = 0; i < 15; i++) {
    const start = performance.now();
    result = compilePacScript(state, options);
    compileTimes.push(performance.now() - start);
  }
  if (!result.ok) throw new Error("compile failed");

  const context = vm.createContext({});
  vm.runInContext(result.script, context);
  const hosts = [
    "a.b.c.d.e.www.site" + Math.max(0, count - 2) + ".zone" + (Math.max(0, count - 2) % 97) + ".example",
    "site0.zone0.example",
    "deep.sub.domain.unknown-host.example.org",
    "www.youtube.com",
    "192.168.1.10",
    "2001:db8::1"
  ];
  context.__hosts = hosts;
  context.__n = LOOKUPS;
  const run = new vm.Script(
    "(function () { var r; for (var i = 0; i < __n; i++) { var h = __hosts[i % __hosts.length]; " +
    "r = FindProxyForURL('https://' + h + '/', h); } return r; })()");
  run.runInContext(context);
  const lookupTimes = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    run.runInContext(context);
    lookupTimes.push(performance.now() - start);
  }

  rows.push({
    rules: count,
    bytes: result.metadata.byteLength,
    kib: (result.metadata.byteLength / 1024).toFixed(1),
    compileMsMedian: median(compileTimes).toFixed(2),
    lookupNsMedian: ((median(lookupTimes) * 1e6) / LOOKUPS).toFixed(0)
  });
}

console.log("node " + process.version);
console.table(rows);
