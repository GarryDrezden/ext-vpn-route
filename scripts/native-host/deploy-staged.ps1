[CmdletBinding()]
param(
    [ValidateSet('Chrome', 'Chromium', 'All')]
    [string]$Target = 'Chrome'
)

# Promotes dist/native-host-staging to dist/native-host while a connectNative session may be active.
# Sequence: unregister (no new browser spawns) -> stop VPN Route host processes at the live path
# -> replace live binary from staging -> register. Does not kill browser or external VPN daemons.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

function Get-VpnRouteNativeHostProcesses {
    param([Parameter(Mandatory = $true)][string]$ExpectedExecutablePath)

    $expected = [IO.Path]::GetFullPath($ExpectedExecutablePath)
    $found = @()
    foreach ($proc in Get-Process -Name $script:NativeHostProcessName -ErrorAction SilentlyContinue) {
        $path = $proc.Path
        if ([string]::IsNullOrWhiteSpace($path)) { continue }
        try {
            $full = [IO.Path]::GetFullPath($path)
        }
        catch { continue }
        if ($full.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
            $found += $proc
        }
    }
    return ,$found
}

function Stop-VpnRouteNativeHostProcesses {
    param([Parameter(Mandatory = $true)][string]$ExpectedExecutablePath)

    $procs = Get-VpnRouteNativeHostProcesses -ExpectedExecutablePath $ExpectedExecutablePath
    foreach ($proc in $procs) {
        Write-Host "Stopping VPN Route native host pid=$($proc.Id)"
        Stop-Process -Id $proc.Id -Force -ErrorAction Stop
    }
    if ($procs.Count -gt 0) {
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $deadline) {
            $alive = @(Get-VpnRouteNativeHostProcesses -ExpectedExecutablePath $ExpectedExecutablePath)
            if ($alive.Count -eq 0) { return }
            Start-Sleep -Milliseconds 200
        }
        throw "VPN Route native host processes did not exit after stop."
    }
}

function Invoke-VpnRouteNativeHostFilePromote {
    param(
        [Parameter(Mandatory = $true)][string]$StagingExecutablePath,
        [Parameter(Mandatory = $true)][string]$LiveExecutablePath
    )

    if (-not (Test-Path -LiteralPath $StagingExecutablePath -PathType Leaf)) {
        throw "Staged native host missing: $StagingExecutablePath (run npm run build:native-host first)."
    }
    $stagingSize = (Get-Item -LiteralPath $StagingExecutablePath).Length
    if ($stagingSize -lt 1024) {
        throw "Staged native host looks invalid (size $stagingSize)."
    }

    $liveDir = Split-Path -Parent $LiveExecutablePath
    [void][IO.Directory]::CreateDirectory($liveDir)
    $prev = "$LiveExecutablePath.prev"
    $tmp = "$LiveExecutablePath.new"
    if (Test-Path -LiteralPath $prev) { Remove-Item -LiteralPath $prev -Force }
    Copy-Item -LiteralPath $StagingExecutablePath -Destination $tmp -Force
    if (Test-Path -LiteralPath $LiveExecutablePath) {
        Move-Item -LiteralPath $LiveExecutablePath -Destination $prev -Force
    }
    try {
        Move-Item -LiteralPath $tmp -Destination $LiveExecutablePath -Force
        if (Test-Path -LiteralPath $prev) { Remove-Item -LiteralPath $prev -Force }
    }
    catch {
        if (Test-Path -LiteralPath $prev) {
            if (Test-Path -LiteralPath $LiveExecutablePath) {
                Remove-Item -LiteralPath $LiveExecutablePath -Force -ErrorAction SilentlyContinue
            }
            Move-Item -LiteralPath $prev -Destination $LiveExecutablePath -Force
        }
        elseif (Test-Path -LiteralPath $tmp) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Restore-VpnRouteNativeHostRegistration {
    param([string]$RegisterTarget = 'Chrome')
    $registerScript = Join-Path $PSScriptRoot 'register.ps1'
    if (-not (Test-Path -LiteralPath $script:ExecutablePath -PathType Leaf)) { return }
    Write-Host 'Attempting native host registration restore after failure...'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $registerScript -Target $RegisterTarget
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Registration restore failed; run scripts/native-host/register.ps1 manually.'
    }
}

$staging = [IO.Path]::GetFullPath($script:StagingExecutablePath)
$live = [IO.Path]::GetFullPath($script:ExecutablePath)
$unregisterScript = Join-Path $PSScriptRoot 'unregister.ps1'
$registerScript = Join-Path $PSScriptRoot 'register.ps1'
$statusScript = Join-Path $PSScriptRoot 'status.ps1'

$unregisterTarget = if ($Target -eq 'Chrome') { 'All' } else { $Target }
$unregistered = $false
try {
    Write-Host "Deploy staged native host -> $live"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $unregisterScript -Target $unregisterTarget
    if ($LASTEXITCODE -ne 0) { throw "unregister.ps1 failed (exit $LASTEXITCODE)." }
    $unregistered = $true

    Stop-VpnRouteNativeHostProcesses -ExpectedExecutablePath $live
    Invoke-VpnRouteNativeHostFilePromote -StagingExecutablePath $staging -LiveExecutablePath $live

    & powershell -NoProfile -ExecutionPolicy Bypass -File $registerScript -Target $Target
    if ($LASTEXITCODE -ne 0) { throw "register.ps1 failed (exit $LASTEXITCODE)." }

    & powershell -NoProfile -ExecutionPolicy Bypass -File $statusScript
    if ($LASTEXITCODE -ne 0) { throw "status.ps1 reported inconsistent state (exit $LASTEXITCODE)." }

    Write-Host 'DEPLOY STAGED NATIVE HOST OK'
}
catch {
    if ($unregistered) {
        Restore-VpnRouteNativeHostRegistration -RegisterTarget $Target
    }
    Write-Error $_
    exit 1
}
