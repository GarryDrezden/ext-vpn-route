# Windows PowerShell 5.1 array/count semantics used by deploy-staged.ps1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '..\..\scripts\native-host\common.ps1')

function Assert-Count {
    param($Value, [int]$Expected, [string]$Label)
    $actual = Get-CollectionCount $Value
    if ($actual -ne $Expected) {
        throw "$Label expected count $Expected got $actual"
    }
}

Assert-Count $null 0 'null value'
Assert-Count (ConvertTo-StringArray $null) 0 'ConvertTo-StringArray null'
Assert-Count (ConvertTo-StringArray @()) 0 'empty'
Assert-Count (ConvertTo-StringArray 'only.example.com') 1 'single string'
Assert-Count (ConvertTo-StringArray @('a.com', 'b.com')) 2 'two strings'

$fromPipeline = ConvertTo-StringArray (@('x.com') | Select-Object -Unique)
Assert-Count $fromPipeline 1 'Select-Object -Unique single'

$fromPipelineMany = ConvertTo-StringArray (@('x.com', 'y.com') | Select-Object -Unique)
Assert-Count $fromPipelineMany 2 'Select-Object -Unique pair'

$versionedExe = [IO.Path]::GetFullPath((Join-Path $env:TEMP "SelectiveVpnRouter.NativeHost.1791613909587.exe"))
New-Item -ItemType File -Path $versionedExe -Force | Out-Null
try {
    $origin = Get-AllowedOrigin
    $json = New-HostManifestJson -ExecutablePath $versionedExe -Origin $origin
    $manifest = $json | ConvertFrom-Json
    if ($manifest.path -cne $versionedExe) {
        throw "manifest path must be exact versioned exe; got $($manifest.path)"
    }
    $manifestPath = [IO.Path]::ChangeExtension($versionedExe, '.json')
    [IO.File]::WriteAllText($manifestPath, $json, (New-Object Text.UTF8Encoding $false))
    $problems = Test-HostManifest -Path $manifestPath -ExecutablePath $versionedExe -Origin $origin
    if ((Get-CollectionCount $problems) -gt 0) {
        throw "Test-HostManifest failed: $($problems -join '; ')"
    }
}
finally {
    Remove-Item -LiteralPath $versionedExe -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath ([IO.Path]::ChangeExtension($versionedExe, '.json')) -Force -ErrorAction SilentlyContinue
}

# PS 5.1: `Get-CollectionCount $x -eq 0` passes `-eq 0` into the function; always parenthesize the call.
$onePath = [string[]]@('C:\vpn-route\SelectiveVpnRouter.NativeHost.1.exe')
if ((Get-CollectionCount $onePath) -ne 1) { throw 'parenthesized count compare failed' }
if ((Get-CollectionCount $onePath -eq 0) -ne 1) { throw 'unparenthesized -eq must not be used as count comparison' }

# Process result shapes (no Win32/CIM): deploy uses Get-CollectionCount on these arrays.
Assert-Count @() 0 'zero matching processes'
Assert-Count @([pscustomobject]@{ ProcessId = 4242 }) 1 'one matching process'
Assert-Count @(
    [pscustomobject]@{ ProcessId = 1 },
    [pscustomobject]@{ ProcessId = 2 }
) 2 'multiple matching processes'

Write-Host 'DEPLOY POWERSHELL SEMANTICS OK'
