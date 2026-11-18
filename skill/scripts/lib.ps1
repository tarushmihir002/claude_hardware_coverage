# lib.ps1 - shared collector for the claude-dashboard skill.
# Defines Get-ClaudeSnapshot which returns a hashtable describing everything
# the local Claude Code process tree is doing right now, plus a timeline.
#
# IMPORTANT (honesty note): the Claude *model* runs in Anthropic's cloud.
# Nothing here measures the model's GPU/RAM. What we measure is the LOCAL
# Claude Code process tree (the Node CLI + every shell/command it spawns)
# and the machine's overall GPU/RAM so you can see local load.

$ErrorActionPreference = 'SilentlyContinue'

function _Redact([string]$s) {
    if (-not $s) { return $s }
    # Scrub common credential shapes so snapshots/dashboards never leak secrets.
    $s = $s -replace '(?i)sk-or-v1-[a-z0-9]{10,}', 'sk-or-v1-***REDACTED***'
    $s = $s -replace '(?i)sk-[a-z0-9]{20,}',       'sk-***REDACTED***'
    $s = $s -replace 'ghp_[A-Za-z0-9]{20,}',       'ghp_***REDACTED***'
    $s = $s -replace 'github_pat_[A-Za-z0-9_]{20,}','github_pat_***REDACTED***'
    $s = $s -replace 'AKIA[A-Z0-9]{12,}',          'AKIA***REDACTED***'
    $s = $s -replace 'xox[baprs]-[A-Za-z0-9-]{10,}','xox-***REDACTED***'
    $s = $s -replace '(?i)(api[_\- ]?key["'':=\s]{1,4})[A-Za-z0-9_\-]{16,}', '$1***REDACTED***'
    $s = $s -replace '(?i)(bearer\s+)[A-Za-z0-9._\-]{16,}', '$1***REDACTED***'
    return $s
}

function _Classify([string]$name, [string]$cmd) {
    switch -Regex ($name) {
        '^(node|claude)'       { if ($cmd -match '(?i)claude') { return 'claude-engine' } else { return 'node' } }
        '(?i)(powershell|pwsh)'{ return 'shell:pwsh' }
        '(?i)bash|(^|\W)sh\.' { return 'shell:bash' }
        '(?i)^cmd'             { return 'shell:cmd' }
        '(?i)conhost'          { return 'console-host' }
        '(?i)git'              { return 'git' }
        '(?i)(rg|ripgrep)'     { return 'search:rg' }
        '(?i)python|^py'       { return 'python' }
        '(?i)nvidia-smi'       { return 'probe:nvidia-smi' }
        '(?i)WmiPrvSE'         { return 'wmi' }
        default                { return $name }
    }
}

function _ProjectDirForCwd {
    $proj = (Get-Location).Path -replace '[^A-Za-z0-9]', '-'
    $dir  = Join-Path $env:USERPROFILE ".claude\projects\$proj"
    if (Test-Path $dir) { return $dir }
    return $null
}

function _CurrentTranscript {
    $dir = _ProjectDirForCwd
    if ($dir) {
        $f = Get-ChildItem -Path $dir -Filter '*.jsonl' -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($f) { return $f.FullName }
    }
    # Fallback: globally newest session transcript.
    $root = Join-Path $env:USERPROFILE '.claude\projects'
    $f = Get-ChildItem -Path $root -Filter '*.jsonl' -Recurse -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($f) { return $f.FullName }
    return $null
}

function Get-ClaudeSnapshot {
    param(
        [int]$HistoryLimit = 25,
        [int]$EventLimit   = 40
    )

    $now = Get-Date

    # ---- System ----------------------------------------------------------
    $os  = Get-CimInstance Win32_OperatingSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    $totalRamMB = [math]::Round($os.TotalVisibleMemorySize / 1024, 0)
    $freeRamMB  = [math]::Round($os.FreePhysicalMemory      / 1024, 0)
    $usedRamMB  = $totalRamMB - $freeRamMB
    $cpuLoad    = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average

    $system = [ordered]@{
        host        = $env:COMPUTERNAME
        cpuName     = ($cpu.Name).Trim()
        cpuCores    = $cpu.NumberOfLogicalProcessors
        cpuLoadPct  = [int]$cpuLoad
        ramTotalMB  = $totalRamMB
        ramUsedMB   = $usedRamMB
        ramUsedPct  = [int][math]::Round(($usedRamMB / [math]::Max($totalRamMB,1)) * 100, 0)
    }

    # ---- GPU (local machine, via nvidia-smi if present) ------------------
    $gpus = @()
    $gpuProcMap = @{}
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        $q = & nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>$null
        foreach ($line in $q) {
            if (-not $line.Trim()) { continue }
            $p = $line -split ',' | ForEach-Object { $_.Trim() }
            $gpus += [ordered]@{
                index    = [int]$p[0]
                name     = $p[1]
                utilPct  = [int]($p[2] -replace '[^\d]', '')
                memUsedMB= [int]($p[3] -replace '[^\d]', '')
                memTotalMB=[int]($p[4] -replace '[^\d]', '')
                tempC    = $p[5]
                powerW   = $p[6]
            }
        }
        # Per-process GPU memory, to attribute GPU use to Claude's tree.
        $ca = & nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>$null
        foreach ($line in $ca) {
            if (-not $line.Trim()) { continue }
            $p = $line -split ',' | ForEach-Object { $_.Trim() }
            $gpuProcMap[[int]$p[0]] = [int]($p[1] -replace '[^\d]', '')
        }
    }

    # ---- Claude process tree --------------------------------------------
    # First CPU sample: note the moment the process table is read.
    $cpuT1 = Get-Date
    $all = Get-CimInstance Win32_Process
    $byPid = @{}; foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }
    $children = @{}
    foreach ($p in $all) {
        $pp = [int]$p.ParentProcessId
        if (-not $children.ContainsKey($pp)) { $children[$pp] = @() }
        $children[$pp] += [int]$p.ProcessId
    }

    # Roots: a node/claude process whose command line mentions claude.
    $roots = $all | Where-Object {
        $_.CommandLine -and $_.CommandLine -match '(?i)claude' -and $_.Name -match '(?i)^(node|claude)'
    } | ForEach-Object { [int]$_.ProcessId }

    # Collect the full tree (roots + all descendants), deduped.
    $seen = @{}
    $stack = New-Object System.Collections.Stack
    foreach ($r in $roots) { $stack.Push($r) }
    while ($stack.Count -gt 0) {
        $id = $stack.Pop()
        if ($seen.ContainsKey($id)) { continue }
        $seen[$id] = $true
        if ($children.ContainsKey($id)) { foreach ($c in $children[$id]) { $stack.Push($c) } }
    }

    $myPid = $PID
    $procs = @()
    $cpuTree1 = 0.0   # unrounded total CPU seconds across the tree at sample 1
    foreach ($id in $seen.Keys) {
        $p = $byPid[$id]
        if (-not $p) { continue }
        $cmd  = if ($p.CommandLine) { $p.CommandLine } else { $p.Name }
        $kind = _Classify $p.Name $cmd
        $start = $p.CreationDate
        $runSec = if ($start) { [int]($now - $start).TotalSeconds } else { 0 }
        $cpuRaw = (([uint64]$p.KernelModeTime + [uint64]$p.UserModeTime) / 1e7)
        $cpuTree1 += $cpuRaw
        $cpuSec = [math]::Round($cpuRaw, 1)
        $ramMB  = [math]::Round($p.WorkingSetSize / 1MB, 1)
        $short  = if ($cmd.Length -gt 140) { $cmd.Substring(0,140) + '...' } else { $cmd }
        $short  = _Redact $short
        $procs += [ordered]@{
            pid       = $id
            ppid      = [int]$p.ParentProcessId
            name      = $p.Name
            kind      = $kind
            ramMB     = $ramMB
            cpuSec    = $cpuSec
            runSec    = $runSec
            gpuMemMB  = if ($gpuProcMap.ContainsKey($id)) { $gpuProcMap[$id] } else { 0 }
            isSelf    = ($id -eq $myPid)
            cmd       = $short
        }
    }
    $procs = $procs | Sort-Object { - $_.ramMB }

    $engine  = @($procs | Where-Object { $_.kind -eq 'claude-engine' })
    # NB: these are ordered-dicts, so Measure-Object -Property can't see the
    # keys; sum manually.
    $treeRam = 0.0; $treeGpu = 0
    foreach ($p in $procs) { $treeRam += [double]$p.ramMB; $treeGpu += [int]$p.gpuMemMB }
    $treeRam = [math]::Round($treeRam, 1)

    # ---- Claude CPU % (two-sample delta) and RAM % ----------------------
    # Second CPU sample after a short wait; the delta over wall-clock time,
    # normalised by logical cores, is Claude's share of total CPU capacity.
    Start-Sleep -Milliseconds 450
    $cpuT2 = Get-Date
    $all2  = Get-CimInstance Win32_Process
    $cpuTree2 = 0.0
    foreach ($p in $all2) {
        if ($seen.ContainsKey([int]$p.ProcessId)) {
            $cpuTree2 += (([uint64]$p.KernelModeTime + [uint64]$p.UserModeTime) / 1e7)
        }
    }
    $cores   = [math]::Max(1, [int]$system.cpuCores)
    $elapsed = ($cpuT2 - $cpuT1).TotalSeconds
    $claudeCpuPct = if ($elapsed -gt 0) {
        [math]::Max(0.0, [math]::Round(((($cpuTree2 - $cpuTree1) / ($elapsed * $cores)) * 100), 1))
    } else { 0 }
    $claudeRamPct = [int][math]::Round(($treeRam / [math]::Max($system.ramTotalMB,1)) * 100, 0)

    # Active jobs = spawned commands that aren't the engine, a console host,
    # a transient probe, or this collector itself. Long runs are flagged.
    $jobs = @($procs | Where-Object {
        $_.kind -notin @('claude-engine','console-host','probe:nvidia-smi','wmi') -and -not $_.isSelf
    } | ForEach-Object {
        $_ + @{ longRunning = ($_.runSec -gt 10) }
    })

    # ---- Transcript timeline --------------------------------------------
    $events = @()
    $tx = _CurrentTranscript
    $sessionId = $null; $sessionFile = $tx
    if ($tx) {
        $lines = Get-Content -Path $tx -Encoding UTF8 -ErrorAction SilentlyContinue
        foreach ($l in $lines) {
            if (-not $l.Trim()) { continue }
            try { $o = $l | ConvertFrom-Json } catch { continue }
            if (-not $sessionId -and $o.sessionId) { $sessionId = $o.sessionId }
            $ts = $o.timestamp
            if ($o.type -eq 'assistant' -and $o.message.content) {
                foreach ($c in $o.message.content) {
                    if ($c.type -eq 'tool_use') {
                        $detail = ''
                        if ($c.input.command)     { $detail = [string]$c.input.command }
                        elseif ($c.input.file_path){ $detail = [string]$c.input.file_path }
                        elseif ($c.input.pattern) { $detail = [string]$c.input.pattern }
                        elseif ($c.input.prompt)  { $detail = [string]$c.input.prompt }
                        if ($detail.Length -gt 120) { $detail = $detail.Substring(0,120) + '...' }
                        $events += [ordered]@{ time=$ts; kind='tool'; label=$c.name; detail=(_Redact $detail) }
                    }
                }
            }
            elseif ($o.type -eq 'user' -and $o.message.content) {
                foreach ($c in $o.message.content) {
                    if ($c.type -eq 'text' -and $c.text) {
                        $t = [string]$c.text
                        if ($t.Length -gt 120) { $t = $t.Substring(0,120) + '...' }
                        $events += [ordered]@{ time=$ts; kind='prompt'; label='user prompt'; detail=(_Redact $t) }
                    }
                }
            }
        }
    }
    $events = @($events | Where-Object { $_.time } | Select-Object -Last $EventLimit)

    # Status heuristic.
    $status = if ($jobs.Count -gt 0) {
        "busy - $($jobs.Count) active command(s) in the tree"
    } elseif ($engine.Count -gt 0) {
        'idle - engine up, awaiting your input'
    } else {
        'no local Claude Code process detected'
    }

    # ---- Prompt history (across all projects) ---------------------------
    $history = @()
    $hf = Join-Path $env:USERPROFILE '.claude\history.jsonl'
    if (Test-Path $hf) {
        $hl = Get-Content -Path $hf -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -Last $HistoryLimit
        foreach ($l in $hl) {
            if (-not $l.Trim()) { continue }
            try { $o = $l | ConvertFrom-Json } catch { continue }
            $dt = $null
            if ($o.timestamp) { $dt = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$o.timestamp).LocalDateTime.ToString('s') }
            $history += [ordered]@{ time=$dt; display=(_Redact ([string]$o.display)); project=$o.project }
        }
        [array]::Reverse($history)
    }

    # ---- Scheduled / time-bound work ------------------------------------
    $scheduled = @()
    $st = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match '(?i)claude' }
    foreach ($t in $st) {
        $info = $t | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
        $scheduled += [ordered]@{
            name     = $t.TaskName
            state    = [string]$t.State
            lastRun  = if ($info) { [string]$info.LastRunTime } else { '' }
            nextRun  = if ($info) { [string]$info.NextRunTime } else { '' }
        }
    }

    return [ordered]@{
        generatedAt   = $now.ToString('s')
        status        = $status
        note          = 'Local Claude Code process tree only. The model itself runs in Anthropic cloud; GPU/RAM below are your machine + local CLI.'
        system        = $system
        gpus          = $gpus
        claudeEngine  = $engine
        processes     = $procs
        treeRamMB     = $treeRam
        treeGpuMemMB  = $treeGpu
        claudeCpuPct  = $claudeCpuPct
        claudeRamPct  = $claudeRamPct
        jobs          = $jobs
        scheduled     = $scheduled
        session       = [ordered]@{ id=$sessionId; file=$sessionFile; cwd=(Get-Location).Path }
        events        = $events
        promptHistory = $history
    }
}
