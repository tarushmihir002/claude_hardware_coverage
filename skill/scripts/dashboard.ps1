# dashboard.ps1 - live, self-refreshing terminal dashboard of Claude Code's
# local activity. Ctrl+C to quit.
# Usage:
#   powershell -File dashboard.ps1                 # refresh every 3s
#   powershell -File dashboard.ps1 -IntervalSec 5
#   powershell -File dashboard.ps1 -Once           # render a single frame
param(
    [int]$IntervalSec = 3,
    [switch]$Once
)
. (Join-Path $PSScriptRoot 'lib.ps1')

function _Bar([int]$pct, [int]$width = 24) {
    $pct = [math]::Max(0, [math]::Min(100, $pct))
    $fill = [int][math]::Round($width * $pct / 100)
    ('#' * $fill) + ('.' * ($width - $fill))
}
function _Dur([int]$s) {
    if ($s -lt 60)   { return "${s}s" }
    if ($s -lt 3600) { return ('{0}m{1:d2}s' -f [int]($s/60), ($s%60)) }
    return ('{0}h{1:d2}m' -f [int]($s/3600), [int](($s%3600)/60))
}
function _C($text, $color) { Write-Host $text -ForegroundColor $color }

function Render {
    $s = Get-ClaudeSnapshot -HistoryLimit 10 -EventLimit 12
    Clear-Host
    _C ("+" + ("-" * 72)) DarkCyan
    _C ("  CLAUDE CODE  -  LIVE ACTIVITY DASHBOARD      {0}" -f $s.generatedAt) Cyan
    $statusColor = if ($s.status -match 'busy') { 'Yellow' } elseif ($s.status -match 'idle') { 'Green' } else { 'Red' }
    Write-Host "  status : " -NoNewline; _C $s.status $statusColor
    _C ("  note   : " + $s.note) DarkGray
    _C ("+" + ("-" * 72)) DarkCyan

    # System
    $sys = $s.system
    Write-Host ""
    _C "  SYSTEM" White
    Write-Host ("   CPU  [{0}] {1,3}%   {2}" -f (_Bar $sys.cpuLoadPct), $sys.cpuLoadPct, $sys.cpuName)
    Write-Host ("   RAM  [{0}] {1,3}%   {2} / {3} MB (used)" -f (_Bar $sys.ramUsedPct), $sys.ramUsedPct, $sys.ramUsedMB, $sys.ramTotalMB)
    foreach ($g in $s.gpus) {
        $memPct = [int]($g.memUsedMB / [math]::Max($g.memTotalMB,1) * 100)
        Write-Host ("   GPU  [{0}] {1,3}%   {2}  mem {3}/{4}MB  {5}C" -f (_Bar $g.utilPct), $g.utilPct, $g.name, $g.memUsedMB, $g.memTotalMB, $g.tempC)
    }

    # Claude footprint
    Write-Host ""
    _C ("  CLAUDE FOOTPRINT (local)   engine procs: {0}   tree RAM: {1} MB   tree GPU: {2} MB" -f $s.claudeEngine.Count, $s.treeRamMB, $s.treeGpuMemMB) White

    # Process tree
    Write-Host ""
    _C "  PROCESS TREE" White
    Write-Host ("   {0,-7} {1,-15} {2,8} {3,8} {4,8}  {5}" -f 'PID','KIND','RAM(MB)','CPU(s)','UPTIME','COMMAND')
    foreach ($p in ($s.processes | Select-Object -First 14)) {
        $tag = if ($p.isSelf) { '*' } else { ' ' }
        $col = switch -Regex ($p.kind) { 'engine' {'Cyan'} 'shell' {'Yellow'} default {'Gray'} }
        $cmd = if ($p.cmd.Length -gt 34) { $p.cmd.Substring(0,34) } else { $p.cmd }
        Write-Host ("  {0}{1,-6} {2,-15} {3,8} {4,8} {5,8}  {6}" -f $tag, $p.pid, $p.kind, $p.ramMB, $p.cpuSec, (_Dur $p.runSec), $cmd) -ForegroundColor $col
    }

    # Jobs / time-bound
    Write-Host ""
    _C ("  ACTIVE JOBS / SPAWNED COMMANDS  ({0})" -f $s.jobs.Count) White
    if ($s.jobs.Count -eq 0) { _C "   (none - no spawned commands running)" DarkGray }
    foreach ($j in ($s.jobs | Select-Object -First 8)) {
        $flag = if ($j.longRunning) { '[long-running]' } else { '' }
        Write-Host ("   {0,-14} {1,8}  {2} {3}" -f $j.kind, (_Dur $j.runSec), ($j.cmd.Substring(0,[math]::Min(40,$j.cmd.Length))), $flag) -ForegroundColor Yellow
    }
    if ($s.scheduled.Count -gt 0) {
        Write-Host ""
        _C "  SCHEDULED TASKS (Windows, name ~ claude)" White
        foreach ($t in $s.scheduled) { Write-Host ("   {0,-28} {1,-10} next: {2}" -f $t.name, $t.state, $t.nextRun) }
    }

    # Timeline
    Write-Host ""
    _C "  RECENT TIMELINE (this session)" White
    foreach ($e in ($s.events | Select-Object -Last 10)) {
        $t = try { ([datetime]$e.time).ToString('HH:mm:ss') } catch { $e.time }
        $col = if ($e.kind -eq 'prompt') { 'Green' } else { 'DarkGray' }
        $d = if ($e.detail) { ' - ' + $e.detail } else { '' }
        Write-Host ("   {0}  {1,-11} {2}{3}" -f $t, $e.label, '', $d) -ForegroundColor $col
    }
    Write-Host ""
    _C "  (Ctrl+C to quit)" DarkGray
}

if ($Once) { Render; return }
while ($true) {
    Render
    Start-Sleep -Seconds $IntervalSec
}
