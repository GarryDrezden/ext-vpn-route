Set-StrictMode -Version Latest

# Production native messaging host registration (HKCU only, no elevation).
# The Phase 0B spike host (com.vpnroute.phase0b) is a different name and is never touched here.

$script:HostName = 'com.vpnroute.browser'
$script:SpikeHostName = 'com.vpnroute.phase0b'
$script:ProtocolVersion = 1
$script:ExpectedExtensionId = 'lfaekfalhkgmbfdjjlfcalanhijeaien'
$script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:ExecutablePath = Join-Path $script:RepoRoot 'dist\native-host\SelectiveVpnRouter.NativeHost.exe'
$script:StagingExecutablePath = Join-Path $script:RepoRoot 'dist\native-host-staging\SelectiveVpnRouter.NativeHost.exe'
$script:NativeHostProcessName = 'SelectiveVpnRouter.NativeHost'
$script:NativeHostProcessFileName = 'SelectiveVpnRouter.NativeHost.exe'
$script:ManifestDirectory = Join-Path $script:RepoRoot 'dist\native-messaging'
$script:ManifestPath = Join-Path $script:ManifestDirectory "$script:HostName.json"
$script:ExtensionManifestPath = Join-Path $script:RepoRoot 'src\extension\manifest.json'
$script:BuildCommand = 'npm run build:native-host'

$script:RegistryTargets = [ordered]@{
    Chrome   = "Software\Google\Chrome\NativeMessagingHosts\$script:HostName"
    Chromium = "Software\Chromium\NativeMessagingHosts\$script:HostName"
}

function ConvertTo-StringArray {
    param([object]$Value)

    # [object[]]@() survives function return under PS 5.1 (bare @() is "no output" -> $null).
    if ($null -eq $Value) { return [object[]]@() }
    if ($Value -is [string]) {
        if ([string]::IsNullOrWhiteSpace($Value)) { return [object[]]@() }
        return @([string]$Value)
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @($Value | ForEach-Object {
            if ($null -eq $_) { return }
            [string]$_
        } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($items.Count -eq 0) { return [object[]]@() }
        return [string[]]$items
    }
    return @([string]$Value)
}

function Get-CollectionCount {
    param($Value)

    if ($null -eq $Value) { return 0 }
    if ($Value -is [string]) { return 1 }
    if ($Value -is [System.Collections.ICollection]) { return $Value.Count }

    $count = 0
    foreach ($_ in $Value) { $count++ }
    return $count
}

function Get-HostTargets {
    param([string]$Target)

    if ($Target -eq 'All') {
        return @($script:RegistryTargets.Keys)
    }
    return @($Target)
}

function Get-ProductionExtensionId {
    if (-not (Test-Path -LiteralPath $script:ExtensionManifestPath -PathType Leaf)) {
        throw "Extension manifest not found: $script:ExtensionManifestPath"
    }
    $manifest = [IO.File]::ReadAllText($script:ExtensionManifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if (-not $manifest.key) {
        throw "Extension manifest has no 'key'; the extension ID would not be stable."
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
    $id = $builder.ToString()
    if ($id -cne $script:ExpectedExtensionId) {
        throw "Extension ID from src/extension/manifest.json is $id, expected $script:ExpectedExtensionId."
    }
    return $id
}

function Get-AllowedOrigin {
    return "chrome-extension://$(Get-ProductionExtensionId)/"
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

function New-HostManifestJson {
    param([string]$ExecutablePath, [string]$Origin)

    $lines = @(
        '{',
        "  `"name`": $(ConvertTo-AsciiJsonString $script:HostName),",
        "  `"description`": $(ConvertTo-AsciiJsonString 'VPN Route browser state bridge'),",
        "  `"path`": $(ConvertTo-AsciiJsonString $ExecutablePath),",
        '  "type": "stdio",',
        "  `"allowed_origins`": [ $(ConvertTo-AsciiJsonString $Origin) ]",
        '}'
    )
    return ($lines -join "`n") + "`n"
}

function Test-HostManifest {
    param([string]$Path, [string]$ExecutablePath, [string]$Origin)

    $problems = New-Object Collections.Generic.List[string]
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        $problems.Add("manifest file missing")
        return ,$problems
    }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $problems.Add("manifest has a UTF-8 BOM")
    }
    try {
        $manifest = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    }
    catch {
        $problems.Add("manifest is not valid JSON")
        return ,$problems
    }
    $names = @($manifest.PSObject.Properties.Name)
    $expectedNames = @('name', 'description', 'path', 'type', 'allowed_origins')
    if ((Compare-Object $names $expectedNames)) { $problems.Add("unexpected manifest fields: $($names -join ', ')") }
    if ($manifest.name -cne $script:HostName) { $problems.Add("name is $($manifest.name)") }
    if ($manifest.type -cne 'stdio') { $problems.Add("type is $($manifest.type)") }
    if ($manifest.path -ne $ExecutablePath) { $problems.Add("path is $($manifest.path)") }
    $origins = [string[]](ConvertTo-StringArray $manifest.allowed_origins)
    if ((Get-CollectionCount $origins) -ne 1 -or $origins[0] -cne $Origin) { $problems.Add("allowed_origins is $($origins -join ', ')") }
    foreach ($o in $origins) {
        if ($o.Contains('*')) { $problems.Add("wildcard origin $o") }
    }
    return ,$problems
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

function Assert-ProductionSubKey {
    param([string]$SubKey)

    if (-not $SubKey.EndsWith("\NativeMessagingHosts\$script:HostName", [StringComparison]::Ordinal) -or
        $SubKey.Contains($script:SpikeHostName)) {
        throw "Refusing to touch registry key $SubKey"
    }
}
