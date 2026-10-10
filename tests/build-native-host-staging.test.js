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

test("build publishes to staging, not live dist", () => {
  assert.match(buildJs, /HOST_STAGING_OUT/);
  assert.match(buildJs, /"-o", HOST_STAGING_OUT/);
  assert.doesNotMatch(buildJs, /rmSync\(HOST_LIVE_OUT/);
  assert.equal(HOST_STAGING_OUT.includes("native-host-staging"), true);
  assert.equal(HOST_LIVE_OUT.includes("native-host-staging"), false);
  assert.equal(HOST_STAGING_EXE.startsWith(HOST_STAGING_OUT), true);
  assert.equal(HOST_EXE.startsWith(HOST_LIVE_OUT), true);
});

test("deploy-staged replaces live host without touching browser processes", () => {
  assert.match(deployPs1, /unregister\.ps1/);
  assert.match(deployPs1, /register\.ps1/);
  assert.match(deployPs1, /Stop-VpnRouteNativeHostProcesses/);
  assert.match(deployPs1, /ExpectedExecutablePath/);
  assert.match(deployPs1, /Restore-VpnRouteNativeHostRegistration/);
  assert.doesNotMatch(deployPs1, /Stop-Process.*browser|yandex|chrome\.exe/i);
  assert.doesNotMatch(deployPs1, /Stop-Process\s+-Name\s+['"]?(chrome|yandex|msedge)/i);
});

test("common.ps1 defines staging and live executable paths", () => {
  assert.match(commonPs1, /native-host-staging/);
  assert.match(commonPs1, /dist\\native-host\\SelectiveVpnRouter\.NativeHost\.exe/);
});
