import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("deploy hashtable splatting binds Target and LiveExecutablePath (PS 5.1)", () => {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(ROOT, "tests/native-host/deploy-parameter-splat-regression.ps1")],
    { encoding: "utf8" }
  );
  assert.match(out, /DEPLOY PARAMETER SPLAT REGRESSION OK/);
});

test("deploy in-process script invocation and post-unregister recovery (PS 5.1)", () => {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(ROOT, "tests/native-host/deploy-inprocess-regression.ps1")],
    { encoding: "utf8" }
  );
  assert.match(out, /DEPLOY INPROCESS REGRESSION OK/);
});

test("deploy PowerShell 5.1 count helpers (0/1/N)", () => {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(ROOT, "tests/native-host/deploy-powershell-semantics.ps1")],
    { encoding: "utf8" }
  );
  assert.match(out, /DEPLOY POWERSHELL SEMANTICS OK/);
});

test("versioned deploy wiring and manifest contract", () => {
  const deploy = readFileSync(path.join(ROOT, "scripts/native-host/deploy-staged.ps1"), "utf8");
  const register = readFileSync(path.join(ROOT, "scripts/native-host/register.ps1"), "utf8");
  const status = readFileSync(path.join(ROOT, "scripts/native-host/status.ps1"), "utf8");
  const common = readFileSync(path.join(ROOT, "scripts/native-host/common.ps1"), "utf8");

  assert.match(deploy, /LiveExecutablePath\s*=\s*\$newExecutablePath/);
  assert.match(deploy, /Target\s*=\s*\$unregisterTarget/);
  assert.match(deploy, /Assert-ManifestPointsToExecutable/);
  assert.match(deploy, /registrationVerified/);
  assert.doesNotMatch(deploy, /powershell\.exe.*register\.ps1/);
  assert.doesNotMatch(deploy, /\$LASTEXITCODE\s+-ne/);
  assert.doesNotMatch(deploy, /ScriptParameters\s*@\(\s*'-Target'/);
  assert.doesNotMatch(deploy, /'-Target',\s*\$/);
  assert.match(common, /function Invoke-VpnRouteNativeHostMaintenanceScript/);
  assert.match(common, /\[hashtable\]\$BoundParameters/);
  assert.match(deploy, /Invoke-VpnRouteNativeHostMaintenanceScript -ScriptPath \$unregisterScript[\s\S]*\$unregistered = \$true/);
  assert.match(status, /throw 'Native host status is inconsistent/);
  assert.match(register, /LiveExecutablePath/);
  assert.match(register, /if \(-not \[string\]::IsNullOrWhiteSpace\(\$LiveExecutablePath\)\)/);
  assert.match(status, /if \(\$manifest\.path\)/);
  assert.match(common, /function ConvertTo-StringArray/);
  assert.match(common, /function Get-CollectionCount/);
  assert.match(common, /\(Get-CollectionCount \$origins\) -ne 1/);
  assert.match(deploy, /\(Get-CollectionCount \$normalized\) -eq 0/);
  assert.match(deploy, /\(Get-CollectionCount \$remaining\) -gt 0/);
  assert.match(common, /ConvertTo-StringArray \$manifest\.allowed_origins/);
});
