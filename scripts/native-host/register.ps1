[CmdletBinding()]
param(
    [ValidateSet('Chrome', 'Chromium', 'All')]
    [string]$Target = 'Chrome',
    [string]$ExecutablePath = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$origin = Get-AllowedOrigin
$exe = if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    [IO.Path]::GetFullPath($script:ExecutablePath)
}
else {
    [IO.Path]::GetFullPath($ExecutablePath)
}

if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Native host executable not found: $exe. Build it first: $script:BuildCommand"
}

[void][IO.Directory]::CreateDirectory($script:ManifestDirectory)
$json = New-HostManifestJson -ExecutablePath $exe -Origin $origin
[IO.File]::WriteAllText($script:ManifestPath, $json, (New-Object Text.UTF8Encoding $false))

$problems = Test-HostManifest -Path $script:ManifestPath -ExecutablePath $exe -Origin $origin
if ($problems.Count -gt 0) {
    throw "Generated manifest failed verification: $($problems -join '; ')"
}

foreach ($name in Get-HostTargets $Target) {
    $subKey = $script:RegistryTargets[$name]
    Assert-ProductionSubKey $subKey
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subKey)
    try {
        $key.SetValue('', $script:ManifestPath, [Microsoft.Win32.RegistryValueKind]::String)
    }
    finally {
        $key.Dispose()
    }
    $readBack = Read-RegistryDefault $subKey
    if ($readBack -ne $script:ManifestPath) {
        throw "Registry read-back mismatch for HKCU\$subKey"
    }
    Write-Host "Registered HKCU\$subKey"
}

Write-Host "Host name:       $script:HostName"
Write-Host "Manifest:        $script:ManifestPath"
Write-Host "Executable:      $exe"
Write-Host "Allowed origin:  $origin"
Write-Host 'REGISTER OK'
