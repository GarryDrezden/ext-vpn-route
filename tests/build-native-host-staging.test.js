import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  HOST_EXE,
  HOST_LIVE_OUT,
  HOST_STAGING_EXE,
  HOST_STAGING_OUT,
  ROOT
} from "../scripts/build-native-host.js";

const buildJs = readFileSync(path.join(ROOT, "scripts/build-native-host.js"), "utf8");
const deployPs1 = readFileSync(path.join(ROOT, "scripts/native-host/deploy-staged.ps1"), "utf8");
const commonPs1 = readFileSync(path.join(ROOT, "scripts/native-host/common.ps1"), "utf8");
const registerPs1 = readFileSync(path.join(ROOT, "scripts/native-host/register.ps1"), "utf8");

test("build publishes to staging, not live dist", () => {
  assert.match(buildJs, /HOST_STAGING_OUT/);
  assert.match(buildJs, /"-o", HOST_STAGING_OUT/);
  assert.doesNotMatch(buildJs, /rmSync\(HOST_LIVE_OUT/);
  assert.equal(HOST_STAGING_OUT.includes("native-host-staging"), true);
  assert.equal(HOST_LIVE_OUT.includes("native-host-staging"), false);
  assert.equal(HOST_STAGING_EXE.startsWith(HOST_STAGING_OUT), true);
  assert.equal(HOST_EXE.startsWith(HOST_LIVE_OUT), true);
});

test("deploy uses versioned live exe so connectNative cannot lock promotion", () => {
  assert.match(deployPs1, /Publish-StagedNativeHostExecutable/);
  assert.match(deployPs1, /SelectiveVpnRouter\.NativeHost\.\$stamp\.exe/);
  assert.match(deployPs1, /'-LiveExecutablePath', \$newExecutablePath/);
  assert.match(deployPs1, /Assert-ManifestPointsToExecutable/);
  assert.match(deployPs1, /Stop-VpnRouteNativeHostProcessesBestEffort/);
  assert.match(deployPs1, /Get-CimInstance Win32_Process/);
  assert.match(deployPs1, /Get-CollectionCount/);
  assert.match(deployPs1, /Old native host process\(es\) still running/);
});

test("deploy does not kill browser processes; stop is scoped by executable path", () => {
  assert.match(deployPs1, /unregister\.ps1/);
  assert.match(deployPs1, /registrationVerified/);
  assert.match(deployPs1, /Restore-VpnRouteNativeHostRegistration/);
  assert.match(deployPs1, /Invoke-VpnRouteNativeHostMaintenanceScript/);
  assert.doesNotMatch(deployPs1, /\$LASTEXITCODE\s+-ne/);
  assert.doesNotMatch(deployPs1, /Stop-Process\s+-Name\s+['"]?(chrome|yandex|msedge|browser)/i);
  assert.match(deployPs1, /ExecutablePaths/);
});

test("register.ps1 uses LiveExecutablePath when explicitly supplied", () => {
  assert.match(registerPs1, /\[string\]\$LiveExecutablePath/);
  assert.match(registerPs1, /IsNullOrWhiteSpace\(\$LiveExecutablePath\)/);
  assert.match(registerPs1, /New-HostManifestJson -ExecutablePath \$exe/);
});

test("common.ps1 defines staging and live executable paths", () => {
  assert.match(commonPs1, /native-host-staging/);
  assert.match(commonPs1, /dist\\native-host\\SelectiveVpnRouter\.NativeHost\.exe/);
  assert.match(commonPs1, /NativeHostProcessFileName/);
  assert.match(commonPs1, /ConvertTo-StringArray/);
});
