# Windows PowerShell 5.1: hashtable splatting for in-process native-host maintenance scripts
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '..\..\scripts\native-host\common.ps1')

function Write-ProbeScript {
    param([string]$Path, [string[]]$Lines)
    Set-Content -LiteralPath $Path -Value $Lines -Encoding UTF8
}

$tempDir = Join-Path $env:TEMP ("vpnroute-splat-regression-" + [Guid]::NewGuid().ToString('n'))
[void][IO.Directory]::CreateDirectory($tempDir)
try {
    $probeUnregister = Join-Path $tempDir 'probe-unregister.ps1'
    Write-ProbeScript -Path $probeUnregister -Lines @(
        'param('
        '    [ValidateSet("Chrome", "Chromium", "All")]'
        '    [string]$Target = "All"'
        ')'
        'if ($Target -ceq "-Target") { throw "Target was bound to literal -Target (string-array splat bug)" }'
        'if ($Target -cne "All") { throw "Expected Target=All got [$Target]" }'
        'Write-Host "PROBE UNREGISTER OK"'
    )

    Invoke-VpnRouteNativeHostMaintenanceScript -ScriptPath $probeUnregister -BoundParameters @{
        Target = 'All'
    }

    $unicodeSegment = -join @([char]0x0420, [char]0x0430, [char]0x0431, [char]0x043E, [char]0x0442, [char]0x0430)
    $unicodeDir = Join-Path $tempDir $unicodeSegment
    [void][IO.Directory]::CreateDirectory($unicodeDir)
    $versionedExe = [IO.Path]::GetFullPath((Join-Path $unicodeDir 'SelectiveVpnRouter.NativeHost.1791613909587.exe'))
    New-Item -ItemType File -Path $versionedExe -Force | Out-Null

    $probeRegister = Join-Path $tempDir 'probe-register.ps1'
    Write-ProbeScript -Path $probeRegister -Lines @(
        'param('
        '    [ValidateSet("Chrome", "Chromium", "All")]'
        '    [string]$Target = "Chrome",'
        '    [Alias("ExecutablePath")]'
        '    [string]$LiveExecutablePath = ""'
        ')'
        'if ($Target -ceq "-Target") { throw "Target was bound to literal -Target" }'
        'if ($Target -cne "Chrome") { throw "Expected Target=Chrome got [$Target]" }'
        'if ([string]::IsNullOrWhiteSpace($LiveExecutablePath)) { throw "LiveExecutablePath missing" }'
        'if ($LiveExecutablePath -cne $env:VPNROUTE_PROBE_EXE) { throw "LiveExecutablePath mismatch: [$LiveExecutablePath]" }'
        'Write-Host "PROBE REGISTER OK"'
    )

    $env:VPNROUTE_PROBE_EXE = $versionedExe
    try {
        Invoke-VpnRouteNativeHostMaintenanceScript -ScriptPath $probeRegister -BoundParameters @{
            Target             = 'Chrome'
            LiveExecutablePath = $versionedExe
        }
    }
    finally {
        Remove-Item Env:VPNROUTE_PROBE_EXE -ErrorAction SilentlyContinue
    }

    $statusScript = Join-Path $PSScriptRoot '..\..\scripts\native-host\status.ps1'
    if (-not (Test-Path -LiteralPath $statusScript -PathType Leaf)) {
        throw "status.ps1 missing: $statusScript"
    }
    try {
        Invoke-VpnRouteNativeHostMaintenanceScript -ScriptPath $statusScript -BoundParameters @{}
    }
    catch {
        if ($_.Exception.Message -match '-Target') {
            throw "status invocation must not treat -Target as the Target parameter value"
        }
    }

    $brokenScript = Join-Path $tempDir 'broken-probe.ps1'
    Write-ProbeScript -Path $brokenScript -Lines @(
        'param('
        '    [ValidateSet("Chrome", "Chromium", "All")]'
        '    [string]$Target = "All"'
        ')'
        'Write-Host "broken probe unexpected success"'
    )
    $brokenArgs = @('-Target', 'All')
    $validateSetFailure = $false
    try {
        & $brokenScript @brokenArgs
    }
    catch {
        $msg = [string]$_.Exception.Message
        if ($msg -match '-Target' -and ($msg -match 'ValidateSet' -or $msg -match 'does not belong')) {
            $validateSetFailure = $true
        }
        else { throw }
    }
    if (-not $validateSetFailure) {
        throw 'string-array splat must fail ValidateSet when Target is bound to -Target (PS 5.1)'
    }

    $unregistered = $false
    $registrationVerified = $false
    $oldPaths = [string[]]@($versionedExe)
    $restoreInvoked = $false
    try {
        Invoke-VpnRouteNativeHostMaintenanceScript -ScriptPath $probeUnregister -BoundParameters @{ Target = 'All' }
        $unregistered = $true
        throw 'simulated deploy failure after unregister'
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
        throw 'recovery guard must still run after unregister when registration is not verified'
    }
}
finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'DEPLOY PARAMETER SPLAT REGRESSION OK'
