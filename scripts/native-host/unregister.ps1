[CmdletBinding()]
param(
    [ValidateSet('Chrome', 'Chromium', 'All')]
    [string]$Target = 'All'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

foreach ($name in Get-HostTargets $Target) {
    $subKey = $script:RegistryTargets[$name]
    Assert-ProductionSubKey $subKey
    if ($null -ne [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKey)) {
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($subKey, $false)
        Write-Host "Removed HKCU\$subKey"
    }
    else {
        Write-Host "Not registered: HKCU\$subKey"
    }
}

$stillRegistered = @($script:RegistryTargets.Values | Where-Object { $null -ne (Read-RegistryDefault $_) })
if ($stillRegistered.Count -eq 0) {
    if (Test-Path -LiteralPath $script:ManifestPath -PathType Leaf) {
        Remove-Item -LiteralPath $script:ManifestPath -Force
        Write-Host "Removed $script:ManifestPath"
    }
    if ((Test-Path -LiteralPath $script:ManifestDirectory -PathType Container) -and
        -not (Get-ChildItem -LiteralPath $script:ManifestDirectory -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $script:ManifestDirectory -Force
    }
}
else {
    Write-Host "Manifest kept: still referenced by $($stillRegistered -join ', ')"
}

Write-Host 'UNREGISTER OK'
