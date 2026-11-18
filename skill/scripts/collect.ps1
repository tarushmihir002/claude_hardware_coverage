# collect.ps1 - emit one snapshot of Claude Code's local activity as JSON.
# Usage:
#   powershell -File collect.ps1                 # JSON to stdout
#   powershell -File collect.ps1 -OutFile x.json # also write to a file
param(
    [string]$OutFile,
    [int]$HistoryLimit = 25,
    [int]$EventLimit   = 40
)
# Emit UTF-8 (no BOM) on stdout so callers like Node decode it correctly.
try {
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
} catch { }

. (Join-Path $PSScriptRoot 'lib.ps1')

$snap = Get-ClaudeSnapshot -HistoryLimit $HistoryLimit -EventLimit $EventLimit
$json = $snap | ConvertTo-Json -Depth 8
if ($OutFile) { $json | Out-File -FilePath $OutFile -Encoding utf8 }
$json
