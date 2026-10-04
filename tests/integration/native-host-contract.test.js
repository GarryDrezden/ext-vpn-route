import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ROOT, PRODUCTION_EXTENSION_ID, NATIVE_HOST_NAME as BUILD_HOST_NAME } from "../../scripts/build-extension.js";
import { ALLOWED_ORIGIN } from "../../scripts/build-native-host.js";
import { NATIVE_HOST_NAME } from "../../src/extension/runtime/config.js";
import { NATIVE_PROTOCOL_VERSION } from "../../src/extension/state/native-state-provider.js";

const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
const ORIGIN = "chrome-extension://" + PRODUCTION_EXTENSION_ID + "/";

test("host name, origin and protocol version agree across C#, PowerShell and the extension", () => {
  assert.equal(NATIVE_HOST_NAME, "com.vpnroute.browser");
  assert.equal(BUILD_HOST_NAME, NATIVE_HOST_NAME);
  assert.equal(ALLOWED_ORIGIN, ORIGIN);

  const protocol = read("src/native-host/Protocol/ProtocolV1.cs");
  assert.match(protocol, /NativeMessagingName = "com\.vpnroute\.browser"/);
  assert.match(protocol, /public const int Version = 1;/);
  assert.equal(NATIVE_PROTOCOL_VERSION, 1);

  const origin = read("src/native-host/Security/CallerOrigin.cs");
  assert.match(origin, new RegExp("ProductionExtensionId = \"" + PRODUCTION_EXTENSION_ID + "\""));

  const common = read("scripts/native-host/common.ps1");
  assert.match(common, /\$script:HostName = 'com\.vpnroute\.browser'/);
  assert.match(common, new RegExp("\\$script:ExpectedExtensionId = '" + PRODUCTION_EXTENSION_ID + "'"));
  assert.match(common, /\$script:ProtocolVersion = 1/);
});

test("production host name differs from the spike host", () => {
  const spike = read("spike/native-host/native-host-common.ps1");
  assert.match(spike, /com\.vpnroute\.phase0b/);
  assert.notEqual(NATIVE_HOST_NAME, "com.vpnroute.phase0b");
});

test("registration scripts use HKCU only, Chrome by default, and never write the spike key", () => {
  const dir = path.join(ROOT, "scripts/native-host");
  const scripts = readdirSync(dir).filter((f) => f.endsWith(".ps1"));
  assert.deepEqual(scripts.sort(), ["common.ps1", "register.ps1", "status.ps1", "unregister.ps1"]);
  for (const file of scripts) {
    const text = readFileSync(path.join(dir, file), "utf8");
    assert.equal(/HKLM|LocalMachine|HKEY_LOCAL_MACHINE/i.test(text), false, file + " touches HKLM");
    assert.equal(/Start-Process|RunAs|-Verb\s/i.test(text), false, file + " elevates or launches processes");
    assert.equal(/Invoke-Expression|\biex\b/i.test(text), false, file);
  }
  const register = read("scripts/native-host/register.ps1");
  assert.match(register, /\[string\]\$Target = 'Chrome'/);
  assert.match(register, /Assert-ProductionSubKey/);
  assert.match(read("scripts/native-host/unregister.ps1"), /Assert-ProductionSubKey/);
  const common = read("scripts/native-host/common.ps1");
  assert.match(common, /CurrentUser/);
  assert.match(common, /Contains\(\$script:SpikeHostName\)/);
});

test("generated manifest has exactly one origin and no wildcard", () => {
  const common = read("scripts/native-host/common.ps1");
  const allowed = /"allowed_origins`": \[ \$\(ConvertTo-AsciiJsonString \$Origin\) \]/;
  assert.match(common, allowed);
  assert.equal(common.includes("chrome-extension://*"), false);
});

test("Service IPC constants agree between the native host and VPN Route Service", (t) => {
  const gatewayRoot = process.env.VPN_GATEWAY_ROOT || path.resolve(ROOT, "..", "vpn-gateway");
  const servicePath = path.join(gatewayRoot, "src/SelectiveVpnRouter.Core/BrowserRouting/BrowserRoutingIpcProtocol.cs");
  let service;
  try {
    service = readFileSync(servicePath, "utf8");
  } catch {
    t.skip("vpn-gateway checkout not found at " + gatewayRoot);
    return;
  }
  const host = read("src/native-host/Service/ServiceIpcV1.cs");
  const constant = (text, name) => {
    const match = new RegExp("const (?:string|int) " + name + " = ([^;]+);").exec(text);
    assert.ok(match, name);
    return match[1].trim();
  };
  for (const name of ["PipeName", "Version", "MaxRequestBytes", "MaxResponseBytes", "GetManifest", "GetPage"]) {
    assert.equal(constant(host, name), constant(service, name), name);
  }
  for (const code of ["browser_state_unavailable", "snapshot_changed", "invalid_cursor"]) {
    assert.ok(service.includes("\"" + code + "\""), "Service code " + code);
    assert.ok(host.includes("ProtocolV1.Errors.") || host.includes("\"" + code + "\""), "host forwards " + code);
  }
  assert.match(service, /MaxPagesPerSnapshot = 160;/);
  assert.match(read("src/extension/state/native-state-provider.js"), /maxPages: 160,/);
});

test("manifest and executable stay outside source control", () => {
  const ignore = read(".gitignore");
  assert.match(ignore, /^dist\/$/m);
});
