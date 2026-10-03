Set-StrictMode -Version Latest

$script:HostName = 'com.vpnroute.phase0b'
$script:HostDirectory = $PSScriptRoot
$script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:ExecutablePath = Join-Path $PSScriptRoot 'bin\Release\net8.0\SelectiveVpnRouter.NativeHost.Spike.exe'
$script:ManifestPath = Join-Path $PSScriptRoot "manifest\$script:HostName.json"
$script:ExtensionManifestPath = Join-Path $script:RepoRoot 'spike\extension\manifest.json'
$script:BuildCommand = 'dotnet build spike\native-host\SelectiveVpnRouter.NativeHost.Spike.csproj -c Release'

$script:RegistryTargets = [ordered]@{
    Chrome   = "Software\Google\Chrome\NativeMessagingHosts\$script:HostName"
    Chromium = "Software\Chromium\NativeMessagingHosts\$script:HostName"
}

function Get-SpikeTargets {
    param([string]$Target)

    if ($Target -eq 'All') {
        return @($script:RegistryTargets.Keys)
    }

    return @($Target)
}

function Get-SpikeExtensionId {
    if (-not (Test-Path -LiteralPath $script:ExtensionManifestPath -PathType Leaf)) {
        throw "Extension manifest not found: $script:ExtensionManifestPath"
    }

    $manifest = [IO.File]::ReadAllText($script:ExtensionManifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if (-not $manifest.key) {
        throw "Extension manifest has no 'key'; extension ID would not be stable."
    }

    $der = [Convert]::FromBase64String([string]$manifest.key)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($der)
    }
    finally {
        $sha.Dispose()
    }

    $builder = New-Object Text.StringBuilder
    for ($i = 0; $i -lt 16; $i++) {
        [void]$builder.Append([char](97 + ($hash[$i] -shr 4)))
        [void]$builder.Append([char](97 + ($hash[$i] -band 0x0F)))
    }

    return $builder.ToString()
}

function ConvertTo-AsciiJsonString {
    param([string]$Value)

    $builder = New-Object Text.StringBuilder
    [void]$builder.Append('"')
    foreach ($ch in $Value.ToCharArray()) {
        $code = [int]$ch
        if ($ch -eq '"') { [void]$builder.Append('\"') }
        elseif ($ch -eq '\') { [void]$builder.Append('\\') }
        elseif ($code -lt 0x20 -or $code -gt 0x7E) { [void]$builder.Append(('\u{0:x4}' -f $code)) }
        else { [void]$builder.Append($ch) }
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Test-RegistryKey {
    param([string]$SubKey)

    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey)
    if ($null -eq $key) {
        return $false
    }

    $key.Dispose()
    return $true
}

function Read-RegistryDefault {
    param([string]$SubKey)

    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey)
    if ($null -eq $key) {
        return $null
    }

    try {
        return [string]$key.GetValue('')
    }
    finally {
        $key.Dispose()
    }
}
