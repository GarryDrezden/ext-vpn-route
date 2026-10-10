import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { ROOT } from "../scripts/build-extension.js";
import { PRODUCTION_EXTENSION_ID, SPIKE_EXTENSION_ID, NATIVE_HOST_NAME } from "../scripts/build-extension.js";

const GATEWAY_ROOT = process.env.VPN_GATEWAY_ROOT
  ? path.resolve(process.env.VPN_GATEWAY_ROOT)
  : path.resolve(ROOT, "..", "vpn-gateway");

const INSTALL_PS1 = path.join(GATEWAY_ROOT, "scripts", "install-vpn-route.ps1");
const HELPERS_PS1 = path.join(GATEWAY_ROOT, "scripts", "_install-vpn-route-helpers.ps1");
const VERIFY_JS = path.join(ROOT, "scripts", "verify-browser-integration-readonly.js");
const PARSE_VALIDATE_PS1 = path.join(GATEWAY_ROOT, "scripts", "validate-install-vpn-route-parse.ps1");

function readGatewayFile(rel) {
  const full = path.join(GATEWAY_ROOT, rel);
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf8");
}

test("install scripts parse in Windows PowerShell 5.1", (t) => {
  if (!existsSync(PARSE_VALIDATE_PS1)) {
    t.skip("validate-install-vpn-route-parse.ps1 missing at " + GATEWAY_ROOT);
  }
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PARSE_VALIDATE_PS1],
    { encoding: "utf8" }
  );
  assert.match(out, /PASS\s+parse/);
});

test("install orchestrator exists in vpn-gateway", (t) => {
  if (!existsSync(INSTALL_PS1)) {
    t.skip("vpn-gateway not at " + GATEWAY_ROOT);
  }
  const ps1 = readFileSync(INSTALL_PS1, "utf8");
  assert.match(ps1, /CheckOnly/);
  assert.match(ps1, /ExtensionRepoPath/);
  assert.match(ps1, /Invoke-VpnRouteDeployStagedNativeHost/);
  assert.doesNotMatch(ps1, /register\.ps1/);
  assert.match(ps1, /Invoke-VpnRouteExtensionBuildPhase/);
  assert.match(ps1, /\& \$updateScript/);
  assert.doesNotMatch(ps1, /register-native-host\.ps1/);
  assert.doesNotMatch(ps1, new RegExp(SPIKE_EXTENSION_ID));
});

test("install helpers enforce production host and extension id", (t) => {
  if (!existsSync(HELPERS_PS1)) t.skip("helpers missing");
  const helpers = readFileSync(HELPERS_PS1, "utf8");
  assert.match(helpers, new RegExp(NATIVE_HOST_NAME));
  assert.match(helpers, new RegExp(PRODUCTION_EXTENSION_ID));
  assert.match(helpers, /browserRoutingWrite/);
  assert.match(helpers, new RegExp(SPIKE_EXTENSION_ID));
  assert.doesNotMatch(helpers, /Stop-Process.*openvpn/i);
  assert.doesNotMatch(helpers, /register\.ps1.*phase0b/i);
  assert.doesNotMatch(helpers, /\u2014/, "helpers must not use Unicode em dash (PS 5.1 UTF-8 no-BOM parse risk)");
});

test("CheckOnly branch avoids build, register, and update-desktop", (t) => {
  if (!existsSync(INSTALL_PS1)) t.skip("install script missing");
  const ps1 = readFileSync(INSTALL_PS1, "utf8");
  const start = ps1.indexOf("if ($CheckOnly)");
  assert.ok(start >= 0, "CheckOnly block missing");
  const end = ps1.indexOf("exit 0", start);
  const block = ps1.slice(start, end);
  assert.doesNotMatch(block, /Invoke-VpnRouteExtensionBuildPhase/);
  assert.doesNotMatch(block, /register\.ps1/);
  assert.doesNotMatch(block, /\& \$updateScript/);
});

test("native host build uses staging; deploy runs only after mutation boundary", (t) => {
  if (!existsSync(HELPERS_PS1)) t.skip("helpers missing");
  const helpers = readFileSync(HELPERS_PS1, "utf8");
  const buildJs = readFileSync(path.join(ROOT, "scripts/build-native-host.js"), "utf8");
  assert.match(buildJs, /native-host-staging/);
  assert.match(helpers, /Invoke-VpnRouteDeployStagedNativeHost/);
  assert.match(helpers, /deploy-staged\.ps1/);
  assert.match(helpers, /Staged native host missing/);
  assert.match(helpers, /native-messaging\\com\.vpnroute\.browser\.json/);
});

test("deploy script scopes process stop to live executable path", (t) => {
  const deploy = readFileSync(path.join(ROOT, "scripts/native-host/deploy-staged.ps1"), "utf8");
  assert.match(deploy, /Win32_Process/);
  assert.match(deploy, /OrdinalIgnoreCase/);
  assert.match(deploy, /NativeHost\.\$stamp\.exe/);
  assert.doesNotMatch(deploy, /Stop-Process.*-Name.*browser/i);
});

test("installer distinguishes pre-mutation vs partial-update failure hints", (t) => {
  if (!existsSync(HELPERS_PS1) || !existsSync(INSTALL_PS1)) t.skip("gateway scripts missing");
  const helpers = readFileSync(HELPERS_PS1, "utf8");
  const install = readFileSync(INSTALL_PS1, "utf8");
  assert.match(helpers, /Write-VpnRouteInstallFailureHint/);
  assert.match(helpers, /INSTALL FAILED BEFORE UPDATE/);
  assert.match(helpers, /No live changes were made/);
  assert.match(helpers, /Partial update - failed at/);
  assert.match(helpers, /Set-VpnRouteInstallMutationStarted/);
  assert.match(install, /Set-VpnRouteInstallMutationStarted/);
  assert.match(install, /Write-VpnRouteInstallFailureHint -Phase \$failedPhase -MutationStarted \$script:VpnRouteInstallMutationStarted/);
  const mutIdx = install.indexOf("Set-VpnRouteInstallMutationStarted");
  const buildIdx = install.indexOf("Invoke-VpnRouteExtensionBuildPhase");
  const updateIdx = install.indexOf("& $updateScript");
  assert.ok(buildIdx >= 0 && mutIdx > buildIdx && updateIdx > mutIdx, "mutation flag must be set after build, before update-desktop");
});

test("orchestration builds extension before update-desktop", (t) => {
  if (!existsSync(INSTALL_PS1)) t.skip("install script missing");
  const ps1 = readFileSync(INSTALL_PS1, "utf8");
  const buildIdx = ps1.indexOf("Invoke-VpnRouteExtensionBuildPhase");
  const updateIdx = ps1.indexOf("& $updateScript");
  assert.ok(buildIdx >= 0 && updateIdx > buildIdx, "extension build must precede desktop update");
});

test("read-only verify script avoids write RPC names", () => {
  const js = readFileSync(VERIFY_JS, "utf8");
  assert.match(js, /getStateManifest|getSnapshot|ping/);
  assert.doesNotMatch(js, /upsertRule\s*\(/);
  assert.doesNotMatch(js, /deleteRule\s*\(/);
  assert.doesNotMatch(js, /resetRules\s*\(/);
  assert.match(js, /browserRoutingWrite/);
  assert.match(js, /--require-browser-routing-push/);
});

test("full install requires browserRoutingPush verify flag; CheckOnly does not", (t) => {
  if (!existsSync(INSTALL_PS1) || !existsSync(HELPERS_PS1)) t.skip("gateway scripts missing");
  const install = readFileSync(INSTALL_PS1, "utf8");
  const helpers = readFileSync(HELPERS_PS1, "utf8");
  assert.match(helpers, /RequireBrowserRoutingPush/);
  assert.match(helpers, /--require-browser-routing-push/);
  assert.match(install, /Invoke-VpnRouteReadOnlyIntegrationVerify -ExtensionRoot \$extensionRoot -RequireBrowserRoutingPush/);
  const checkStart = install.indexOf("if ($CheckOnly)");
  const checkEnd = install.indexOf("exit 0", checkStart);
  const checkBlock = install.slice(checkStart, checkEnd);
  assert.match(checkBlock, /Invoke-VpnRouteReadOnlyIntegrationVerify -ExtensionRoot \$extensionRoot/);
  assert.doesNotMatch(checkBlock, /RequireBrowserRoutingPush/);
});

test("verify script does not use chrome.storage.local for drafts", () => {
  const draft = readFileSync(path.join(ROOT, "src/extension/popup/rule-editor-draft.js"), "utf8");
  assert.match(draft, /chrome\.storage\.session/);
  assert.doesNotMatch(draft, /chrome\.storage\.local/);
});
