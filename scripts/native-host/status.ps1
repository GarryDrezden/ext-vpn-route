[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$origin = Get-AllowedOrigin
$exe = $null
if (Test-Path -LiteralPath $script:ManifestPath -PathType Leaf) {
    try {
        $manifest = [IO.File]::ReadAllText($script:ManifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($manifest.path) {
            $exe = [IO.Path]::GetFullPath([string]$manifest.path)
        }
    }
    catch { }
}
if (-not $exe) {
    $exe = [IO.Path]::GetFullPath($script:ExecutablePath)
}
$exeExists = Test-Path -LiteralPath $exe -PathType Leaf
$problems = New-Object Collections.Generic.List[string]

Write-Host "Host name:        $script:HostName"
Write-Host "Protocol version: $script:ProtocolVersion"
Write-Host "Extension origin: $origin"
if ($exeExists) {
    Write-Host "Executable:       $exe ($((Get-Item -LiteralPath $exe).Length) bytes)"
}
else {
    Write-Host "Executable:       $exe (MISSING; build with $script:BuildCommand)"
}

$registered = @()
foreach ($name in $script:RegistryTargets.Keys) {
    $subKey = $script:RegistryTargets[$name]
    $value = Read-RegistryDefault $subKey
    if ($null -eq $value) {
        Write-Host ("Registry {0,-9} HKCU\{1}: not registered" -f $name, $subKey)
        continue
    }
    $registered += $name
    Write-Host ("Registry {0,-9} HKCU\{1} -> {2}" -f $name, $subKey, $value)
    if ($value -ne $script:ManifestPath) { $problems.Add("$name key points to $value") }
}

if (Test-Path -LiteralPath $script:ManifestPath -PathType Leaf) {
    Write-Host "Manifest:         $script:ManifestPath"
    $manifestProblems = Test-HostManifest -Path $script:ManifestPath -ExecutablePath $exe -Origin $origin
    foreach ($p in $manifestProblems) { $problems.Add("manifest: $p") }
}
else {
    Write-Host "Manifest:         $script:ManifestPath (not generated)"
}

if ($registered.Count -gt 0 -and -not $exeExists) { $problems.Add('registered, but the executable is missing') }
if ($registered.Count -gt 0 -and -not (Test-Path -LiteralPath $script:ManifestPath -PathType Leaf)) { $problems.Add('registered, but the manifest is missing') }

$spikeKeys = @("Software\Google\Chrome\NativeMessagingHosts\$script:SpikeHostName", "Software\Chromium\NativeMessagingHosts\$script:SpikeHostName") |
    Where-Object { $null -ne (Read-RegistryDefault $_) }
Write-Host "Spike host keys:  $(if ($spikeKeys) { $spikeKeys -join ', ' } else { 'none' }) (informational, not managed here)"

if ($problems.Count -gt 0) {
    foreach ($p in $problems) { Write-Host "PROBLEM: $p" }
    Write-Host 'STATUS: INCONSISTENT'
    exit 1
}
Write-Host ("STATUS: {0}" -f $(if ($registered.Count -gt 0) { "REGISTERED ($($registered -join ', '))" } else { 'NOT REGISTERED' }))
