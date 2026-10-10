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

    $normalized = [string[]](ConvertTo-StringArray $ExecutablePaths | ForEach-Object { [IO.Path]::GetFullPath($_) } | Select-Object -Unique)
    $normalized = [string[]](ConvertTo-StringArray $normalized)

    $found = @()
    foreach ($proc in Get-CimInstance Win32_Process -Filter "Name='$($script:NativeHostProcessFileName)'" -ErrorAction SilentlyContinue) {
        $path = [string]$proc.ExecutablePath
        if ([string]::IsNullOrWhiteSpace($path)) { continue }
        try {
            $full = [IO.Path]::GetFullPath($path)
        }
        catch { continue }
        if ((Get-CollectionCount $normalized) -eq 0) {
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
    return ,@($found)
}

function Stop-VpnRouteNativeHostProcessesBestEffort {
    param(
        [Parameter(Mandatory = $true)][string[]]$ExecutablePaths,
        [int]$TimeoutSeconds = 12
    )

    $paths = [string[]](ConvertTo-StringArray $ExecutablePaths)
    if ((Get-CollectionCount $paths) -eq 0) { return }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $stoppedIds = @{}
    while ((Get-Date) -lt $deadline) {
        $alive = Get-VpnRouteNativeHostCimProcesses -ExecutablePaths $paths
        if ((Get-CollectionCount $alive) -eq 0) { return }
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
    $remaining = Get-VpnRouteNativeHostCimProcesses -ExecutablePaths $paths
    if ((Get-CollectionCount $remaining) -gt 0) {
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
    return [string[]](ConvertTo-StringArray ($paths | Select-Object -Unique))
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

function Assert-ManifestPointsToExecutable {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath
    )

    if (-not (Test-Path -LiteralPath $script:ManifestPath -PathType Leaf)) {
        throw "Native messaging manifest missing after register: $($script:ManifestPath)"
    }
    $manifest = [IO.File]::ReadAllText($script:ManifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $manifestPath = [IO.Path]::GetFullPath([string]$manifest.path)
    $expected = [IO.Path]::GetFullPath($ExpectedExecutablePath)
    if (-not $manifestPath.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Manifest executable mismatch. Expected: $expected Actual: $manifestPath"
    }
}

function Invoke-VpnRouteNativeHostMaintenanceScript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [object[]]$ScriptParameters = @()
    )

    # In-process .ps1 calls have no native exit code under Set-StrictMode Latest; rely on throw / ErrorAction Stop.
    & $ScriptPath @ScriptParameters
}

function Restore-VpnRouteNativeHostRegistration {
    param(
        [string]$RegisterTarget = 'Chrome',
        [string]$LiveExecutablePath = ''
    )
    $registerScript = Join-Path $PSScriptRoot 'register.ps1'
    $restoreExe = if ($LiveExecutablePath) { $LiveExecutablePath } else { $script:ExecutablePath }
    if (-not (Test-Path -LiteralPath $restoreExe -PathType Leaf)) { return }
    Write-Host 'Attempting native host registration restore after failure...'
    try {
        if ($LiveExecutablePath) {
            Invoke-VpnRouteNativeHostMaintenanceScript -ScriptPath $registerScript -ScriptParameters @('-Target', $RegisterTarget, '-LiveExecutablePath', $restoreExe)
        }
        else {
            Invoke-VpnRouteNativeHostMaintenanceScript -ScriptPath $registerScript -ScriptParameters @('-Target', $RegisterTarget)
        }
    }
    catch {
        Write-Warning "Registration restore failed: $($_.Exception.Message)"
        Write-Warning 'Run scripts/native-host/register.ps1 manually.'
    }
}

$staging = [IO.Path]::GetFullPath($script:StagingExecutablePath)
$liveDir = [IO.Path]::GetFullPath((Join-Path $script:RepoRoot 'dist\native-host'))
$unregisterScript = Join-Path $PSScriptRoot 'unregister.ps1'
$registerScript = Join-Path $PSScriptRoot 'register.ps1'
$statusScript = Join-Path $PSScriptRoot 'status.ps1'

$oldExecutablePaths = Read-RegisteredNativeHostExecutablePaths
$newExecutablePath = $null
$registrationVerified = $false
$unregisterTarget = if ($Target -eq 'Chrome') { 'All' } else { $Target }
$unregistered = $false
try {
    Write-Host "Deploy staged native host -> $liveDir (versioned exe)"
    Invoke-VpnRouteNativeHostMaintenanceScript -ScriptPath $unregisterScript -ScriptParameters @('-Target', $unregisterTarget)
    $unregistered = $true

    $newExecutablePath = Publish-StagedNativeHostExecutable -StagingExecutablePath $staging -LiveDirectory $liveDir
    Write-Host "Published live binary: $newExecutablePath"

    Invoke-VpnRouteNativeHostMaintenanceScript -ScriptPath $registerScript -ScriptParameters @('-Target', $Target, '-LiveExecutablePath', $newExecutablePath)
    Assert-ManifestPointsToExecutable -ExpectedExecutablePath $newExecutablePath
    $registrationVerified = $true

    if ((Get-CollectionCount $oldExecutablePaths) -gt 0) {
        Stop-VpnRouteNativeHostProcessesBestEffort -ExecutablePaths $oldExecutablePaths
    }

    Invoke-VpnRouteNativeHostMaintenanceScript -ScriptPath $statusScript

    Write-Host 'DEPLOY STAGED NATIVE HOST OK'
}
catch {
    if ($unregistered -and -not $registrationVerified) {
        $oldPaths = [string[]](ConvertTo-StringArray $oldExecutablePaths)
        if ((Get-CollectionCount $oldPaths) -gt 0) {
            Restore-VpnRouteNativeHostRegistration -RegisterTarget $Target -LiveExecutablePath $oldPaths[0]
        }
    }
    Write-Error $_
    exit 1
}
