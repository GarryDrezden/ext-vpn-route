[CmdletBinding()]
param(
    [switch]$Finish
)

# Phase 5 manual acceptance helper. Prepare (default): publish the host, build the Native
# extension, register the host in HKCU and run a read-only check against the live Service.
# -Finish: unregister the host and restore the Fixture build.
# Never touches VPN, the Service, HKLM or proxy settings.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Invoke-Step([string]$Title, [scriptblock]$Body) {
    Write-Host "== $Title"
    & $Body
    if ($LASTEXITCODE -ne 0) { throw "$Title failed (exit $LASTEXITCODE)" }
}

if ($Finish) {
    Invoke-Step 'unregister host' { powershell -NoProfile -ExecutionPolicy Bypass -File scripts\native-host\unregister.ps1 }
    Invoke-Step 'host status' { powershell -NoProfile -ExecutionPolicy Bypass -File scripts\native-host\status.ps1 }
    Invoke-Step 'restore Fixture build' { npm run build:extension }
    Write-Host 'DONE: host unregistered, dist\extension is the Fixture build. Press "Reload" on the VPN Route card.'
    exit 0
}

Invoke-Step 'publish native host' { npm run build:native-host }
Invoke-Step 'build Native extension' { npm run build:extension:native }
Invoke-Step 'register host (HKCU)' { powershell -NoProfile -ExecutionPolicy Bypass -File scripts\native-host\register.ps1 }
Invoke-Step 'host status' { powershell -NoProfile -ExecutionPolicy Bypass -File scripts\native-host\status.ps1 }
Write-Host '== live Service check (read-only)'
node scripts\check-live-service.js
if ($LASTEXITCODE -ne 0) { Write-Host 'WARNING: live Service check failed; the popup will show the same failure.' }
Write-Host 'READY: press "Reload" on the VPN Route card, open the popup, click "Refresh state & apply".'
