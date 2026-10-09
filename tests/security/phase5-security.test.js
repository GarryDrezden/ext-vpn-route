import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DIST_ROOT, ROOT, buildExtension } from "../../scripts/build-extension.js";

const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
const GATEWAY = process.env.VPN_GATEWAY_ROOT || path.resolve(ROOT, "..", "vpn-gateway");

function gateway(t, file) {
  try {
    return readFileSync(path.join(GATEWAY, file), "utf8");
  } catch {
    t.skip("vpn-gateway checkout not found at " + GATEWAY);
    return null;
  }
}

function files(dir, extension) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test("Service browser endpoint: local named pipe only, no TCP, no network port", (t) => {
  const dir = path.join(GATEWAY, "src/SelectiveVpnRouter.Core/BrowserRouting");
  if (gateway(t, "src/SelectiveVpnRouter.Core/BrowserRouting/BrowserRoutingPipeServer.cs") === null) return;
  const sources = [...files(dir, ".cs"), path.join(GATEWAY, "src/SelectiveVpnRouter.Service/BrowserRoutingPipeHost.cs")];
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\b(TcpListener|HttpListener|UdpClient|Socket|IPEndPoint|Kestrel|WebSocket)\b/, file);
    assert.doesNotMatch(text, /Process\.Start|RunAsClient|ImpersonateNamedPipeClient/, file);
  }
});

test("Service browser pipe ACL: no Everyone / Authenticated Users / Users, Network denied, first instance only", (t) => {
  const server = gateway(t, "src/SelectiveVpnRouter.Core/BrowserRouting/BrowserRoutingPipeServer.cs");
  if (server === null) return;
  const code = server.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /WorldSid|AuthenticatedUserSid|BuiltinUsersSid|AnonymousSid|"S-1-1-0"|Everyone/);
  assert.match(server, /SetAccessRuleProtection\(isProtected: true/);
  assert.match(server, /InteractiveSid, null\), PipeAccessRights\.ReadWrite, AccessControlType\.Allow/);
  assert.match(server, /NetworkSid, null\), PipeAccessRights\.FullControl, AccessControlType\.Deny/);
  assert.match(server, /PipeOptions\.FirstPipeInstance/);
});

test("Service browser endpoint exposes exactly getManifest and getPage; no admin or service-control methods", (t) => {
  const protocol = gateway(t, "src/SelectiveVpnRouter.Core/BrowserRouting/BrowserRoutingIpcProtocol.cs");
  if (protocol === null) return;
  const block = /static class Methods\s*\{([^}]*)\}/.exec(protocol);
  assert.ok(block, "Methods block");
  const methods = [...block[1].matchAll(/const string \w+ = "(\w+)";/g)].map((m) => m[1]);
  assert.deepEqual(methods.sort(), ["getManifest", "getPage"]);
  for (const forbidden of ["SetConfig", "ConnectVpn", "DisconnectVpn", "EmergencyRestore", "RunDiagnostic", "Shutdown", "Upsert", "Delete"]) {
    assert.equal(protocol.includes("\"" + forbidden), false, forbidden);
  }
  const host = read("src/native-host/Service/ServiceIpcV1.cs");
  assert.match(host, /GetManifest = "getManifest"/);
  assert.match(host, /GetPage = "getPage"/);
  assert.equal(/"(SetConfig|ConnectVpn|EmergencyRestore|GetStatus)"/.test(host), false);
});

test("native host: no generic {command,args} relay, no stored state, exact origin", () => {
  const dispatcher = read("src/native-host/Protocol/RequestDispatcher.cs");
  assert.doesNotMatch(dispatcher, /"args"|"method"\s*:|PayloadJson/);
  const origin = read("src/native-host/Security/CallerOrigin.cs");
  assert.match(origin, /AllowedOrigin = "chrome-extension:\/\/" \+ ProductionExtensionId \+ "\/"/);
  assert.equal(origin.includes("*"), false);
  for (const file of files(path.join(ROOT, "src/native-host"), ".cs").filter((f) => !/[\\/](bin|obj)[\\/]/.test(f))) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\b(File|Directory|FileStream)\.\w+\(/, file);
    assert.doesNotMatch(text, /\b(TcpClient|TcpListener|HttpClient|Socket)\b/, file);
  }
});

test("Native extension build: no fixture, no spike endpoint in use, no rules in chrome.storage", async () => {
  const outDir = path.join(DIST_ROOT, ".test-sec-" + process.pid, "extension");
  try {
    await buildExtension({ mode: "native", outDir });
    const sources = files(outDir, ".js");
    const names = sources.map((f) => path.relative(outDir, f).replace(/\\/g, "/"));
    assert.equal(names.includes("extension/state/smoke-state.js"), false);
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      const name = path.relative(outDir, file).replace(/\\/g, "/");
      if (name !== "extension/runtime/config.js") {
        assert.equal(text.includes("PHASE3_PROXY_ENDPOINT"), false, name);
        assert.equal(text.includes("17891"), false, name);
      }
      assert.doesNotMatch(text, /\bfetch\(|new WebSocket|XMLHttpRequest|connectNative|setInterval\(/, name);
      assert.doesNotMatch(text, /dnsResolve\(|myIpAddress\(/, name);
    }
    const coordinator = readFileSync(path.join(outDir, "extension/runtime/routing-coordinator.js"), "utf8");
    assert.equal(/storage\.write\([^)]*rules/.test(coordinator), false);
  } finally {
    rmSync(path.dirname(outDir), { recursive: true, force: true });
  }
});

test("extension applies only Ready loopback endpoints and never installs DIRECT on failure", () => {
  const coordinator = read("src/extension/runtime/routing-coordinator.js");
  assert.match(coordinator, /stateRequiresVpnFailClosedRouting|snapshot\.browserProxy\.status === "Ready"/);
  assert.doesNotMatch(coordinator, /mode:\s*"direct"|"DIRECT"/);
  const controller = read("src/extension/runtime/proxy-controller.js");
  assert.doesNotMatch(controller, /mode:\s*"direct"|mode:\s*"system"/);
  const snapshot = read("src/extension/state/snapshot.js");
  assert.match(snapshot, /validateProxyEndpoint/);
});
