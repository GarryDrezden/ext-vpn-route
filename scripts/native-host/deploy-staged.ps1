[CmdletBinding()]
param(
    [ValidateSet('Chrome', 'Chromium', 'All')]
    [string]$Target = 'Chrome'
)

# Promotes dist/native-host-staging to a NEW versioned exe under dist/native-host (never overwrites a
# running connectNative binary). Unregister -> publish new file -> register -> best-effort stop old PIDs.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

function Get-VpnRouteNativeHostCimProcesses {
    param([string[]]$ExecutablePaths = @())

    $normalized = @(
        foreach ($p in $ExecutablePaths) {
            if ([string]::IsNullOrWhiteSpace($p)) { continue }
            [IO.Path]::GetFullPath($p)
        }
    ) | Select-Object -Unique

    $found = @()
    foreach ($proc in Get-CimInstance Win32_Process -Filter "Name='$($script:NativeHostProcessFileName)'" -ErrorAction SilentlyContinue) {
        $path = [string]$proc.ExecutablePath
        if ([string]::IsNullOrWhiteSpace($path)) { continue }
        try {
            $full = [IO.Path]::GetFullPath($path)
        }
        catch { continue }
        if ($normalized.Count -eq 0) {
            if ($full.StartsWith([IO.Path]::GetFullPath((Join-Path $script:RepoRoot 'dist\native-host')), [StringComparison]::OrdinalIgnoreCase)) {
                $found += $proc
            }
            continue
        }
        foreach ($expected in $normalized) {
            if ($full.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
                $found += $proc
                break
            }
        }
    }
    return ,$found
}

function Stop-VpnRouteNativeHostProcessesBestEffort {
    param(
        [Parameter(Mandatory = $true)][string[]]$ExecutablePaths,
        [int]$TimeoutSeconds = 12
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $stoppedIds = @{}
    while ((Get-Date) -lt $deadline) {
        $alive = @(Get-VpnRouteNativeHostCimProcesses -ExecutablePaths $ExecutablePaths)
        if ($alive.Count -eq 0) { return }
        foreach ($proc in $alive) {
            $pid = [int]$proc.ProcessId
            if ($stoppedIds.ContainsKey($pid)) { continue }
            Write-Host "Stopping VPN Route native host pid=$pid"
            try {
                Stop-Process -Id $pid -Force -ErrorAction Stop
            }
            catch {
                Write-Warning "Stop-Process pid=$pid failed: $($_.Exception.Message)"
            }
            $stoppedIds[$pid] = $true
        }
        Start-Sleep -Milliseconds 250
    }
    $remaining = @(Get-VpnRouteNativeHostCimProcesses -ExecutablePaths $ExecutablePaths)
    if ($remaining.Count -gt 0) {
        $ids = ($remaining | ForEach-Object { $_.ProcessId }) -join ', '
        Write-Warning "Old native host process(es) still running after ${TimeoutSeconds}s (pids: $ids); new version is already registered."
    }
}

function Read-RegisteredNativeHostExecutablePaths {
    $paths = New-Object Collections.Generic.List[string]
    if (Test-Path -LiteralPath $script:ManifestPath -PathType Leaf) {
        try {
            $manifest = [IO.File]::ReadAllText($script:ManifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
            if ($manifest.path) { [void]$paths.Add([string]$manifest.path) }
        }
        catch { }
    }
    if (Test-Path -LiteralPath $script:ExecutablePath -PathType Leaf) {
        [void]$paths.Add($script:ExecutablePath)
    }
    return ,@($paths | Select-Object -Unique)
}

function Publish-StagedNativeHostExecutable {
    param(
        [Parameter(Mandatory = $true)][string]$StagingExecutablePath,
        [Parameter(Mandatory = $true)][string]$LiveDirectory
    )

    if (-not (Test-Path -LiteralPath $StagingExecutablePath -PathType Leaf)) {
        throw "Staged native host missing: $StagingExecutablePath (run npm run build:native-host first)."
    }
    $stagingSize = (Get-Item -LiteralPath $StagingExecutablePath).Length
    if ($stagingSize -lt 1024) {
        throw "Staged native host looks invalid (size $stagingSize)."
    }

    [void][IO.Directory]::CreateDirectory($LiveDirectory)
    $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $target = Join-Path $LiveDirectory ("SelectiveVpnRouter.NativeHost.$stamp.exe")
    Copy-Item -LiteralPath $StagingExecutablePath -Destination $target -Force
    return [IO.Path]::GetFullPath($target)
}

function Restore-VpnRouteNativeHostRegistration {
    param(
        [string]$RegisterTarget = 'Chrome',
        [string]$ExecutablePath = ''
    )
    $registerScript = Join-Path $PSScriptRoot 'register.ps1'
    $restoreExe = if ($ExecutablePath) { $ExecutablePath } else { $script:ExecutablePath }
    if (-not (Test-Path -LiteralPath $restoreExe -PathType Leaf)) { return }
    Write-Host 'Attempting native host registration restore after failure...'
    if ($ExecutablePath) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $registerScript -Target $RegisterTarget -ExecutablePath $restoreExe
    }
    else {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $registerScript -Target $RegisterTarget
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Registration restore failed; run scripts/native-host/register.ps1 manually.'
    }
}

$staging = [IO.Path]::GetFullPath($script:StagingExecutablePath)
$liveDir = [IO.Path]::GetFullPath((Join-Path $script:RepoRoot 'dist\native-host'))
$unregisterScript = Join-Path $PSScriptRoot 'unregister.ps1'
$registerScript = Join-Path $PSScriptRoot 'register.ps1'
$statusScript = Join-Path $PSScriptRoot 'status.ps1'

$oldExecutablePaths = @(Read-RegisteredNativeHostExecutablePaths)
$newExecutablePath = $null
$unregisterTarget = if ($Target -eq 'Chrome') { 'All' } else { $Target }
$unregistered = $false
try {
    Write-Host "Deploy staged native host -> $liveDir (versioned exe)"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $unregisterScript -Target $unregisterTarget
    if ($LASTEXITCODE -ne 0) { throw "unregister.ps1 failed (exit $LASTEXITCODE)." }
    $unregistered = $true

    $newExecutablePath = Publish-StagedNativeHostExecutable -StagingExecutablePath $staging -LiveDirectory $liveDir
    Write-Host "Published live binary: $newExecutablePath"

    & powershell -NoProfile -ExecutionPolicy Bypass -File $registerScript -Target $Target -ExecutablePath $newExecutablePath
    if ($LASTEXITCODE -ne 0) { throw "register.ps1 failed (exit $LASTEXITCODE)." }

    if ($oldExecutablePaths.Count -gt 0) {
        Stop-VpnRouteNativeHostProcessesBestEffort -ExecutablePaths $oldExecutablePaths
    }

    & powershell -NoProfile -ExecutionPolicy Bypass -File $statusScript
    if ($LASTEXITCODE -ne 0) { throw "status.ps1 reported inconsistent state (exit $LASTEXITCODE)." }

    Write-Host 'DEPLOY STAGED NATIVE HOST OK'
}
catch {
    if ($unregistered) {
        $restorePath = if ($newExecutablePath -and (Test-Path -LiteralPath $newExecutablePath)) {
            $newExecutablePath
        }
        elseif ($oldExecutablePaths.Count -gt 0) {
            $oldExecutablePaths[0]
        }
        else {
            ''
        }
        Restore-VpnRouteNativeHostRegistration -RegisterTarget $Target -ExecutablePath $restorePath
    }
    Write-Error $_
    exit 1
}
