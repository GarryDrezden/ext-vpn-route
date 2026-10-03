[CmdletBinding()]
param(
    [ValidateSet('All', 'Chrome', 'Chromium')]
    [string]$Target = 'All'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-host-common.ps1')

Write-Host "Phase 0B native host unregistration (HKCU only)"

foreach ($name in Get-SpikeTargets $Target) {
    $subKey = $script:RegistryTargets[$name]
    if (-not (Test-RegistryKey $subKey)) {
        Write-Host "Not registered: HKCU\$subKey"
        continue
    }

    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($subKey, $false)
    if (Test-RegistryKey $subKey) {
        Write-Host "ERROR: HKCU\$subKey still exists" -ForegroundColor Red
        exit 1
    }

    Write-Host "Removed:        HKCU\$subKey"

    $parent = Split-Path -Parent $subKey
    while ($parent -and $parent -ne 'Software') {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($parent)
        if ($null -eq $key) {
            break
        }

        $empty = $key.SubKeyCount -eq 0 -and $key.ValueCount -eq 0
        $key.Dispose()
        if (-not $empty) {
            break
        }

        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($parent, $false)
        Write-Host "Removed empty:  HKCU\$parent"
        $parent = Split-Path -Parent $parent
    }
}

Write-Host "OK. Generated manifest is left in place and is inert without a registry key:"
Write-Host "  $script:ManifestPath"
