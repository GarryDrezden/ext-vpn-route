[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-host-common.ps1')

$problems = 0
$registered = 0
$extensionId = Get-SpikeExtensionId
$expectedOrigin = "chrome-extension://$extensionId/"

Write-Host "Host name:            $script:HostName"
Write-Host "Expected extension:   $extensionId"
Write-Host "Expected executable:  $script:ExecutablePath"
Write-Host ("Executable exists:    " + (Test-Path -LiteralPath $script:ExecutablePath -PathType Leaf))
Write-Host ""

$manifestPaths = New-Object System.Collections.Generic.List[string]
foreach ($name in $script:RegistryTargets.Keys) {
    $subKey = $script:RegistryTargets[$name]
    $value = Read-RegistryDefault $subKey
    if ($null -eq $value) {
        Write-Host "[$name] HKCU\$subKey : not registered"
        continue
    }

    $registered++
    Write-Host "[$name] HKCU\$subKey"
    Write-Host "  -> $value"
    if (-not $manifestPaths.Contains($value)) {
        $manifestPaths.Add($value)
    }
}

foreach ($path in $manifestPaths) {
    Write-Host ""
    Write-Host "Manifest: $path"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "  ERROR: manifest file not found" -ForegroundColor Red
        $problems++
        continue
    }

    try {
        $manifest = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    }
    catch {
        Write-Host "  ERROR: manifest is not valid JSON: $($_.Exception.Message)" -ForegroundColor Red
        $problems++
        continue
    }

    $origins = @($manifest.allowed_origins)
    Write-Host "  name:            $($manifest.name)"
    Write-Host "  type:            $($manifest.type)"
    Write-Host "  path:            $($manifest.path)"
    Write-Host ("  path exists:     " + (Test-Path -LiteralPath $manifest.path -PathType Leaf))
    Write-Host "  allowed_origins: $($origins -join ', ')"

    if ($manifest.name -ne $script:HostName) { Write-Host "  ERROR: name mismatch" -ForegroundColor Red; $problems++ }
    if ($manifest.type -ne 'stdio') { Write-Host "  ERROR: type must be stdio" -ForegroundColor Red; $problems++ }
    if (-not (Test-Path -LiteralPath $manifest.path -PathType Leaf)) { Write-Host "  ERROR: executable missing" -ForegroundColor Red; $problems++ }
    if ($origins.Count -ne 1 -or $origins[0] -ne $expectedOrigin) {
        Write-Host "  ERROR: allowed_origins must be exactly $expectedOrigin" -ForegroundColor Red
        $problems++
    }
}

if ($manifestPaths.Count -eq 0 -and (Test-Path -LiteralPath $script:ManifestPath -PathType Leaf)) {
    Write-Host ""
    Write-Host "Generated manifest exists but is not registered: $script:ManifestPath"
}

Write-Host ""
if ($problems -gt 0) {
    Write-Host "STATUS: ERROR ($problems problem(s))" -ForegroundColor Red
    exit 1
}

if ($registered -eq 0) {
    Write-Host "STATUS: NOT REGISTERED"
    exit 0
}

Write-Host "STATUS: OK ($registered registry key(s))" -ForegroundColor Green
exit 0
