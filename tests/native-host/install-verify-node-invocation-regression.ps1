# Regression: node stderr must not terminate install verify when exit code is 0.
$ErrorActionPreference = 'Stop'
$gatewayRoot = if ($env:VPN_GATEWAY_ROOT) { $env:VPN_GATEWAY_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\vpn-gateway')).Path }
. (Join-Path $gatewayRoot 'scripts\_install-vpn-route-helpers.ps1')

$stubDir = Join-Path ([System.IO.Path]::GetTempPath()) ('vpnroute-node-stub-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stubDir | Out-Null
$stubJs = Join-Path $stubDir 'stub-verify.js'
@'
console.log("PASS  native host ping");
console.warn("WARN  Service UNAVAILABLE; host bridge OK (read-only verify partial).");
'@ | Set-Content -LiteralPath $stubJs -Encoding UTF8

try {
    $result = Invoke-VpnRouteNodeCommand -ArgumentList @($stubJs)
    if ($result.ExitCode -ne 0) {
        throw "expected exit 0, got $($result.ExitCode)"
    }
    if ($result.StdErr -notmatch 'WARN') {
        throw 'expected stderr WARN from stub'
    }

    $failJs = Join-Path $stubDir 'stub-fail.js'
    @'
console.error("ERR  simulated verify failure");
process.exit(2);
'@ | Set-Content -LiteralPath $failJs -Encoding UTF8
    $fail = Invoke-VpnRouteNodeCommand -ArgumentList @($failJs)
    if ($fail.ExitCode -ne 2) {
        throw "expected exit 2, got $($fail.ExitCode)"
    }
}
finally {
    Remove-Item -LiteralPath $stubDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output 'PASS install-verify-node-invocation-regression'
