[CmdletBinding()]
param(
    [ValidateSet('All', 'Chrome', 'Chromium')]
    [string]$Target = 'Chrome'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-host-common.ps1')

Write-Host "Phase 0B native host registration (HKCU only)"
Write-Host "Host name:  $script:HostName"

if (-not (Test-Path -LiteralPath $script:ExecutablePath -PathType Leaf)) {
    Write-Host "ERROR: native host executable not found:" -ForegroundColor Red
    Write-Host "  $script:ExecutablePath"
    Write-Host "Build it from the repo root:"
    Write-Host "  $script:BuildCommand"
    exit 1
}

$extensionId = Get-SpikeExtensionId
$origin = "chrome-extension://$extensionId/"
Write-Host "Executable: $script:ExecutablePath"
Write-Host "Extension:  $extensionId"

$json = @(
    '{'
    '  "name": ' + (ConvertTo-AsciiJsonString $script:HostName) + ','
    '  "description": "VPN Route Phase 0B native messaging spike (ping/pong only)",'
    '  "path": ' + (ConvertTo-AsciiJsonString $script:ExecutablePath) + ','
    '  "type": "stdio",'
    '  "allowed_origins": ['
    '    ' + (ConvertTo-AsciiJsonString $origin)
    '  ]'
    '}'
) -join "`n"

$manifestDirectory = Split-Path -Parent $script:ManifestPath
if (-not (Test-Path -LiteralPath $manifestDirectory)) {
    [void](New-Item -ItemType Directory -Path $manifestDirectory)
}

[IO.File]::WriteAllText($script:ManifestPath, $json + "`n", (New-Object Text.UTF8Encoding $false))
$parsed = [IO.File]::ReadAllText($script:ManifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
if ($parsed.path -ne $script:ExecutablePath -or @($parsed.allowed_origins).Count -ne 1 -or $parsed.allowed_origins[0] -ne $origin) {
    Write-Host "ERROR: written manifest does not round-trip" -ForegroundColor Red
    exit 1
}
Write-Host "Manifest:   $script:ManifestPath"

foreach ($name in Get-SpikeTargets $Target) {
    $subKey = $script:RegistryTargets[$name]
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subKey)
    try {
        $key.SetValue('', $script:ManifestPath, [Microsoft.Win32.RegistryValueKind]::String)
    }
    finally {
        $key.Dispose()
    }

    $actual = Read-RegistryDefault $subKey
    if ($actual -ne $script:ManifestPath) {
        Write-Host "ERROR: HKCU\$subKey was not written" -ForegroundColor Red
        exit 1
    }

    Write-Host "Registered: HKCU\$subKey"
}

Write-Host "OK. Reload the unpacked extension, then press 'Ping native host' in its popup." -ForegroundColor Green
