import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../scripts/build-extension.js";

const GATEWAY_ROOT = process.env.VPN_GATEWAY_ROOT
  ? path.resolve(process.env.VPN_GATEWAY_ROOT)
  : path.resolve(ROOT, "..", "vpn-gateway");

const HELPERS_PS1 = path.join(GATEWAY_ROOT, "scripts", "_install-vpn-route-helpers.ps1");

function parseDotnetTestCount(output) {
  if (!existsSync(HELPERS_PS1)) {
    throw new Error("helpers missing at " + GATEWAY_ROOT);
  }
  const escaped = HELPERS_PS1.replace(/'/g, "''");
  const ps = `
    $ErrorActionPreference = 'Stop'
    . '${escaped}'
    Get-VpnRouteDotnetTestCount -Output $env:VPN_ROUTE_TEST_OUTPUT
  `;
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
    encoding: "utf8",
    env: { ...process.env, VPN_ROUTE_TEST_OUTPUT: output }
  }).trim();
}

test("installer helpers do not hardcode native host PassDetail 219", (t) => {
  if (!existsSync(HELPERS_PS1)) t.skip("vpn-gateway not at " + GATEWAY_ROOT);
  const helpers = readFileSync(HELPERS_PS1, "utf8");
  assert.doesNotMatch(helpers, /PassDetail\s+'219'/);
  assert.match(helpers, /ParseDotnetTestCount/);
  assert.match(helpers, /Get-VpnRouteDotnetTestCount/);
});

test("Get-VpnRouteDotnetTestCount parses Russian dotnet summary", (t) => {
  if (!existsSync(HELPERS_PS1)) t.skip("helpers missing");
  const sample = [
    "Тестовый запуск для E:\\repo\\SelectiveVpnRouter.NativeHost.Tests.dll (.NETCoreApp,Version=v10.0)",
    "Пройден!   : не пройдено     0, пройдено   223, пропущено     0, всего   223, длительность 13 s."
  ].join("\n");
  assert.equal(parseDotnetTestCount(sample), "223");
});

test("Get-VpnRouteDotnetTestCount parses English dotnet summary", (t) => {
  if (!existsSync(HELPERS_PS1)) t.skip("helpers missing");
  const sample = [
    "Passed!  - Failed:     0, Passed:   223, Skipped:     0, Total:   223, Duration: 13 s"
  ].join("\n");
  assert.equal(parseDotnetTestCount(sample), "223");
});

test("Get-VpnRouteDotnetTestCount returns empty for unrecognized output", (t) => {
  if (!existsSync(HELPERS_PS1)) t.skip("helpers missing");
  assert.equal(parseDotnetTestCount("BUILD OK\nno test summary here"), "");
});

test("Get-VpnRouteDotnetTestCount rejects mismatched passed/total", (t) => {
  if (!existsSync(HELPERS_PS1)) t.skip("helpers missing");
  const sample = "Passed!  - Failed: 1, Passed:   220, Skipped:     0, Total:   223, Duration: 13 s";
  assert.equal(parseDotnetTestCount(sample), "");
});
