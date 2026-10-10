# Regression: in-process native-host .ps1 calls under Set-StrictMode Latest (Windows PowerShell 5.1)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '..\..\scripts\native-host\common.ps1')

$tempDir = Join-Path $env:TEMP ("vpnroute-deploy-regression-" + [Guid]::NewGuid().ToString('n'))
[void][IO.Directory]::CreateDirectory($tempDir)
try {
    $okScript = Join-Path $tempDir 'stub-unregister.ps1'
    @'
Write-Host 'UNREGISTER OK'
'@ | Set-Content -LiteralPath $okScript -Encoding UTF8

    Invoke-VpnRouteNativeHostMaintenanceScript -ScriptPath $okScript -BoundParameters @{}

    $failScript = Join-Path $tempDir 'stub-fail.ps1'
    @'
throw 'stub terminating error'
'@ | Set-Content -LiteralPath $failScript -Encoding UTF8

    $caught = $false
    try {
        Invoke-VpnRouteNativeHostMaintenanceScript -ScriptPath $failScript -BoundParameters @{}
        throw 'expected stub script to throw'
    }
    catch {
        if ($_.Exception.Message -cne 'stub terminating error') { throw }
        $caught = $true
    }
    if (-not $caught) { throw 'terminating error did not propagate' }

    $unregistered = $false
    $registrationVerified = $false
    $oldPaths = [string[]]@((Join-Path $tempDir 'SelectiveVpnRouter.NativeHost.old.exe'))
    New-Item -ItemType File -Path $oldPaths[0] -Force | Out-Null
    $restoreInvoked = $false
    try {
        Invoke-VpnRouteNativeHostMaintenanceScript -ScriptPath $okScript -BoundParameters @{}
        $unregistered = $true
        throw 'simulated failure immediately after unregister'
    }
    catch {
        if ($unregistered -and -not $registrationVerified) {
            $paths = [string[]](ConvertTo-StringArray $oldPaths)
            if ((Get-CollectionCount $paths) -gt 0 -and (Test-Path -LiteralPath $paths[0] -PathType Leaf)) {
                $restoreInvoked = $true
            }
        }
    }
    if (-not $restoreInvoked) {
        throw 'post-unregister failure must trigger restore when previous executable exists'
    }
}
finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'DEPLOY INPROCESS REGRESSION OK'
