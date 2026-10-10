# Windows PowerShell 5.1: $pid collides with read-only automatic $PID
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$assignFailed = $false
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $null = ($pid = 4242)
}
catch {
    $assignFailed = $true
}
finally {
    $ErrorActionPreference = $previousEap
}
if (-not $assignFailed) {
    $err = $Error | Where-Object { $_.FullyQualifiedErrorId -eq 'VariableNotWritable' } | Select-Object -First 1
    if ($null -ne $err) { $assignFailed = $true }
}
if (-not $assignFailed) {
    throw 'assigning to $pid must fail (conflicts with read-only automatic $PID)'
}

$currentProcessId = $PID
$stoppedIds = @{}
foreach ($mockProc in @(
        [pscustomobject]@{ ProcessId = 1001 },
        [pscustomobject]@{ ProcessId = 1002 }
    )) {
    $nativeHostProcessId = [int]$mockProc.ProcessId
    if ($stoppedIds.ContainsKey($nativeHostProcessId)) { continue }
    $stoppedIds[$nativeHostProcessId] = $true
}
if ($stoppedIds.Count -ne 2) {
    throw "expected two distinct process ids in cleanup map, got $($stoppedIds.Count)"
}
if ($PID -ne $currentProcessId) {
    throw 'automatic $PID must remain readable after cleanup loop'
}

Write-Host 'DEPLOY PID CLEANUP REGRESSION OK'
