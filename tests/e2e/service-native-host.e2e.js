// Cross-process E2E: VPN Route Service test host (production store, dispatcher and pipe server)
// -> real named pipe -> published production native host exe (one process per message, NM framing)
// -> extension NativeStateProvider / RoutingCoordinator.
//
// Offline and side-effect free: the Service stand-in listens on a private test pipe in a temp
// store directory; it never starts the router engine, never touches VPN, routes, WFP, the registry
// or %ProgramData%. The real Service (if running) is not contacted.
//
// Run: npm run test:e2e   (E2E_SKIP_BUILD=1 reuses existing binaries)

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { HOST_EXE, ROOT, hostEnv, newTestPipeName, processRuntime } from "../../scripts/build-native-host.js";
import { compileBrowserRoutingState } from "../../src/domain/browser-routing/index.js";
import { compilePacScript } from "../../src/pac/index.js";
import { createProxyController } from "../../src/extension/runtime/proxy-controller.js";
import { Decision, Protection, StateSource, createRoutingCoordinator } from "../../src/extension/runtime/routing-coordinator.js";
import { createNativeStateProvider } from "../../src/extension/state/native-state-provider.js";
import { createFakeProxy, createFakeStorage } from "../extension/fakes.js";
import { loadPac } from "../pac/helpers.js";

const GATEWAY = process.env.VPN_GATEWAY_ROOT || path.resolve(ROOT, "..", "vpn-gateway");
const TESTHOST_DIR = path.join(GATEWAY, "tests", "SelectiveVpnRouter.BrowserRouting.TestHost");
const TESTHOST_EXE = path.join(TESTHOST_DIR, "bin", "Release", "net10.0-windows10.0.19041.0", "SelectiveVpnRouter.BrowserRouting.TestHost.exe");
const E2E_PORT = 18765;
const NM_LIMIT = 1024 * 1024;
const SERVICE_RESPONSE_LIMIT = 512 * 1024;
const REPORT = path.join(ROOT, "dist", "e2e", "service-native-host-report.json");
const report = { startedAt: new Date().toISOString(), scenarios: {} };
const temp = mkdtempSync(path.join(os.tmpdir(), "vpnroute-e2e-"));

before(() => {
  if (process.env.E2E_SKIP_BUILD !== "1") {
    execFileSync("dotnet", ["build", path.join(TESTHOST_DIR, "SelectiveVpnRouter.BrowserRouting.TestHost.csproj"), "-c", "Release", "--nologo", "-v", "q"], { stdio: "inherit" });
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-native-host.js")], { stdio: "inherit" });
  }
  assert.ok(existsSync(TESTHOST_EXE), "Service test host not built: " + TESTHOST_EXE);
  assert.ok(existsSync(HOST_EXE), "native host not published: " + HOST_EXE);
});

after(() => {
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(path.dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
});

/** Starts the Service stand-in and waits for "READY <generation> <revision> <count>". */
async function startService({ rules = 0, profile = "typical", proxyPort = null, defaultRoute = "Direct" } = {}) {
  const pipe = newTestPipeName();
  const store = mkdtempSync(path.join(temp, "store-"));
  const args = ["--pipe", pipe, "--store", store, "--rules", String(rules), "--profile", profile, "--default", defaultRoute];
  if (proxyPort !== null) args.push("--proxy", "ready:" + proxyPort);
  const child = spawn(TESTHOST_EXE, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = [];
  lines.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
  });
  const nextLine = (label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " timed out; stderr: " + Buffer.concat(stderr).toString())), 60000);
    waiting.push((line) => { clearTimeout(timer); resolve(line); });
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));

  const ready = (await nextLine("READY")).split(" ");
  assert.equal(ready[0], "READY");
  const service = {
    pipe,
    generation: ready[1],
    revision: Number(ready[2]),
    count: Number(ready[3]),
    log: () => Buffer.concat(stderr).toString("utf8"),
    async command(text) {
      child.stdin.write(text + "\n");
      return (await nextLine(text)).split(" ");
    },
    async stop() {
      if (child.exitCode === null) child.stdin.write("quit\n");
      const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000))]);
      if (code === "timeout") child.kill();
      return code;
    }
  };
  return service;
}

function client(service, options = {}) {
  const frames = [];
  const runtime = processRuntime(HOST_EXE, hostEnv(service.pipe), (message, result) => {
    frames.push({ command: message.command, bytes: result.sizes[0], ok: result.responses[0] && result.responses[0].ok });
  });
  const provider = createNativeStateProvider({ runtime, hostName: "com.vpnroute.browser", snapshotTimeoutMs: 180000, ...options });
  return { provider, frames };
}

function frameStats(frames) {
  const pages = frames.filter((f) => f.command === "getStatePage");
  return {
    messages: frames.length,
    pages: pages.length,
    largestFrameBytes: Math.max(...frames.map((f) => f.bytes)),
    largestPageFrameBytes: pages.length ? Math.max(...pages.map((f) => f.bytes)) : 0,
    totalFrameBytes: frames.reduce((sum, f) => sum + f.bytes, 0)
  };
}

function nativeCoordinator(provider) {
  const proxy = createFakeProxy();
  const controller = createProxyController({ proxy, storage: createFakeStorage(), compile: compilePacScript });
  const coordinator = createRoutingCoordinator({ mode: StateSource.Native, controller, provider, storage: createFakeStorage() });
  return { proxy, coordinator };
}

/** PAC routes for every rule host, a subdomain of it and unmatched hosts agree with the domain matcher. */
function assertRoutingMatches(state, port) {
  const compiled = compilePacScript(state, { proxyHost: "127.0.0.1", proxyPort: port });
  assert.equal(compiled.ok, true);
  const pac = loadPac(compiled.script);
  const matcher = compileBrowserRoutingState(state);
  assert.equal(matcher.ok, true);
  const hosts = [];
  for (const rule of state.rules) {
    hosts.push(rule.host);
    if (rule.host.length + 9 <= 253) hosts.push("deep.sub." + rule.host);
  }
  hosts.push("unmatched.example", "e2e-routing.example", "example.org");
  const actual = pac.findMany(hosts);
  const vpn = "SOCKS5 127.0.0.1:" + port;
  hosts.forEach((host, index) => {
    const expected = matcher.match(host);
    assert.equal(expected.ok, true, host);
    assert.equal(actual[index], expected.effectiveRoute === "VPN" ? vpn : "DIRECT", host + " (" + expected.reason + ")");
  });
  return { pacBytes: compiled.metadata.byteLength, hostsChecked: hosts.length };
}

describe("Service -> IPC -> native host -> extension (cross-process)", { concurrency: false }, () => {
  test("10000 typical rules, browser proxy Ready: paged, validated, compiled, route-matched, applied", async () => {
    const service = await startService({ rules: 10000, proxyPort: E2E_PORT, defaultRoute: "VPN" });
    try {
      assert.equal(service.count, 10000);
      const { provider, frames } = client(service);
      const started = Date.now();
      const result = await provider.getSnapshot();
      const durationMs = Date.now() - started;

      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.deepEqual(result.identity, { stateGeneration: service.generation, revision: service.revision });
      assert.equal(result.snapshot.state.rules.length, 10000);
      assert.equal(result.snapshot.state.defaultRoute, "VPN");
      assert.deepEqual(result.snapshot.browserProxy, { status: "Ready", endpoint: { host: "127.0.0.1", port: E2E_PORT } });
      const stats = frameStats(frames);
      assert.ok(stats.pages > 1, "expected several pages, got " + stats.pages);
      assert.equal(stats.pages, result.stats.pages);
      for (const frame of frames) {
        assert.equal(frame.ok, true);
        assert.ok(frame.bytes < NM_LIMIT, "frame " + frame.bytes + " >= 1 MiB");
        assert.ok(frame.bytes <= SERVICE_RESPONSE_LIMIT + 1024, "frame " + frame.bytes + " exceeds the Service budget");
      }
      const ids = result.snapshot.state.rules.map((rule) => rule.id);
      assert.deepEqual(ids, [...ids].sort(), "deterministic ordinal order");

      const routing = assertRoutingMatches(result.snapshot.state, E2E_PORT);

      const { proxy, coordinator } = nativeCoordinator(provider);
      let view = await coordinator.sync("e2e");
      assert.equal(view.source.lastDecision.kind, Decision.Applied);
      assert.equal(view.protection, Protection.Current);
      assert.equal(proxy.calls.set.length, 1);
      assert.equal(proxy.ours.pacScript.mandatory, true);
      assert.equal(view.diagnostics.lastApplied.revision, service.revision);

      view = await coordinator.sync("e2e");
      assert.equal(view.source.lastDecision.kind, Decision.Unchanged);
      assert.equal(proxy.calls.set.length, 1);

      const [, bumped] = await service.command("bump");
      view = await coordinator.sync("e2e");
      assert.equal(view.source.lastDecision.kind, Decision.Applied);
      assert.equal(view.diagnostics.lastApplied.revision, Number(bumped));

      const [, newGeneration, resetRevision] = await service.command("reset");
      assert.notEqual(newGeneration, service.generation);
      view = await coordinator.sync("e2e");
      assert.equal(view.source.lastDecision.kind, Decision.Applied);
      assert.match(view.source.lastDecision.message, /new lineage/);
      assert.deepEqual(view.source.lineage.appliedIdentity, { stateGeneration: newGeneration, revision: Number(resetRevision) });
      assert.deepEqual(view.source.lineage.retiredGenerations, [service.generation]);

      assert.equal(service.log().includes("site1.region1"), false, "the Service log must not contain hosts");
      report.scenarios.typical10000 = { ...stats, providerStats: result.stats, durationMs, ...routing };
    } finally {
      await service.stop();
    }
  });

  test("10000 rules, browser proxy Unavailable: State AVAILABLE, nothing applied, never DIRECT", async () => {
    const service = await startService({ rules: 10000 });
    try {
      const { provider, frames } = client(service);
      const { proxy, coordinator } = nativeCoordinator(provider);
      const view = await coordinator.sync("e2e");

      assert.equal(view.source.service, "AVAILABLE");
      assert.equal(view.source.state, "AVAILABLE");
      assert.equal(view.source.browserProxy, "UNAVAILABLE");
      assert.equal(view.source.lastFetch.result, "OK");
      assert.equal(view.source.lastDecision.kind, Decision.BrowserProxyUnavailable);
      assert.equal(proxy.calls.set.length, 0);
      assert.equal(proxy.calls.clear, 0);
      assert.equal(proxy.owner, "none");
      assert.equal(view.protection, Protection.NotProtected);
      report.scenarios.unavailable10000 = frameStats(frames);
    } finally {
      await service.stop();
    }
  });

  test("10000 worst-case rules (max field lengths, non-ASCII): within 160 pages, every frame < 1 MiB", async () => {
    const service = await startService({ rules: 10000, profile: "worst", proxyPort: E2E_PORT });
    try {
      const { provider, frames } = client(service);
      const started = Date.now();
      const result = await provider.getSnapshot();
      const durationMs = Date.now() - started;

      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(result.snapshot.state.rules.length, 10000);
      const stats = frameStats(frames);
      assert.ok(stats.pages > 100 && stats.pages <= 160, "pages " + stats.pages);
      for (const frame of frames) assert.ok(frame.bytes <= SERVICE_RESPONSE_LIMIT + 1024 && frame.bytes < NM_LIMIT, String(frame.bytes));
      assert.equal(result.snapshot.state.rules[0].host.length, 253);
      const routing = assertRoutingMatches(result.snapshot.state, E2E_PORT);
      report.scenarios.worst10000 = { ...stats, providerStats: result.stats, durationMs, ...routing };
    } finally {
      await service.stop();
    }
  });

  test("state changing during every attempt: snapshot_unstable after 2 attempts, last-known-good kept", async () => {
    const service = await startService({ rules: 6000, proxyPort: E2E_PORT });
    try {
      const { provider, frames } = client(service);
      const { proxy, coordinator } = nativeCoordinator(provider);
      let view = await coordinator.sync("e2e");
      assert.equal(view.source.lastDecision.kind, Decision.Applied);
      const pac = proxy.ours.pacScript.data;

      await service.command("churn on");
      frames.length = 0;
      view = await coordinator.sync("e2e");
      assert.equal(view.source.lastFetch.errorCode, "snapshot_unstable");
      assert.equal(view.source.lastFetch.stats.attempts, 2);
      assert.equal(view.source.lastDecision.kind, Decision.FetchFailed);
      assert.equal(proxy.ours.pacScript.data, pac);
      assert.equal(proxy.calls.set.length, 1);
      assert.equal(view.protection, Protection.LastKnownGood);
      assert.equal(frames.filter((f) => f.command === "getStateManifest").length, 2);
      assert.ok(frames.some((f) => f.ok === false), "snapshot_changed must reach the extension");

      await service.command("churn off");
      view = await coordinator.sync("e2e");
      assert.equal(view.source.lastDecision.kind, Decision.Applied);
      report.scenarios.churn = { unstableMessages: frames.length };
    } finally {
      await service.stop();
    }
  });

  test("Service gone: service_unavailable, nothing cleared", async () => {
    const service = await startService({ rules: 10, proxyPort: E2E_PORT });
    const { provider } = client(service);
    const { proxy, coordinator } = nativeCoordinator(provider);
    assert.equal((await coordinator.sync("e2e")).source.lastDecision.kind, Decision.Applied);
    await service.stop();

    const view = await coordinator.sync("e2e");
    assert.equal(view.source.service, "UNAVAILABLE");
    assert.equal(view.source.lastFetch.hostErrorCode, "service_unavailable");
    assert.equal(proxy.calls.clear, 0);
    assert.equal(proxy.calls.set.length, 1);
    assert.equal(view.protection, Protection.LastKnownGood);
  });
});
