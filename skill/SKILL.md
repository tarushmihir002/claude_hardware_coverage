---
name: claude-dashboard
description: >-
  Show a dashboard of what Claude Code is doing on this machine right now: the
  local Claude process tree and every command/shell it spawned, their RAM/CPU,
  system + GPU usage, active/background/scheduled jobs, what Claude is waiting
  on, and a timestamped timeline/history of recent actions and prompts. Use
  when the user asks to "see what Claude is running", "show a dashboard",
  "what's Claude doing / waiting for", "how much RAM/GPU is Claude using",
  "show history of what Claude did", or runs /claude-dashboard.
---

# Claude Activity Dashboard

Gives the user a live view of what Claude Code is doing locally plus a history
timeline. Two renderings are available: a **live terminal dashboard** and a
**rich HTML dashboard artifact**.

## Honesty / scope (always tell the user)

The Claude **model** runs in Anthropic's cloud. Nothing here measures the
model's own GPU/RAM — those live remotely. What this skill measures is:

- The **local Claude Code process tree**: the Node CLI engine process(es) plus
  every shell, `git`, `rg`, `python`, MCP server, etc. it has spawned.
- Your **machine's** CPU / RAM / GPU (via `nvidia-smi` when present), so you can
  see local load, with per-process GPU memory attributed to Claude's tree.
- Jobs (spawned/background/long-running commands), Windows scheduled tasks whose
  name contains "claude", and whether Claude looks **busy** vs **idle/waiting**.
- A **timeline** from the current session transcript (tool calls + your prompts)
  and recent prompt **history** across all projects from `~/.claude/history.jsonl`.

Cloud **routines** (scheduled cloud agents from the `schedule` skill) are not
stored on disk, so they do not appear here; mention that if the user asks about
scheduled cloud jobs, and point them to the `schedule` skill / `/schedule`.

## Files

- `scripts/lib.ps1` — shared collector (`Get-ClaudeSnapshot`). Windows/PowerShell.
- `scripts/collect.ps1` — emits one snapshot as JSON (used to build the HTML).
- `scripts/dashboard.ps1` — live self-refreshing terminal dashboard.

## How to run it

### 1. Live terminal dashboard (hand this command to the user)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.claude\skills\claude-dashboard\scripts\dashboard.ps1" -IntervalSec 3
```

It refreshes in place every few seconds; Ctrl+C quits. `-Once` renders a single
frame. This runs fully locally and keeps updating on its own — don't try to
babysit it from the agent loop.

### 2. HTML dashboard artifact (you build this)

1. Run the collector into the session scratchpad:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "<this skill>\scripts\collect.ps1" -OutFile "<scratchpad>\snapshot.json"
   ```
2. Read `snapshot.json`.
3. Load the `artifact-design` skill (and `dataviz` for the meters/timeline), then
   build a single self-contained HTML artifact from the JSON with:
   - a header showing `generatedAt`, `status`, and the honesty note;
   - stat tiles / meters for system CPU, RAM, and each GPU (util + memory), plus
     Claude's tree RAM and attributed GPU memory;
   - a **process tree** table (pid, kind, RAM, CPU seconds, uptime, command);
   - an **active jobs** panel (long-running flagged) and any scheduled tasks;
   - a **timeline** of recent session events (tool calls + prompts) and a recent
     **prompt history** list, both with timestamps.
   The HTML is a snapshot; tell the user to re-invoke the skill to refresh it, or
   use the terminal dashboard for live updates.

Default to producing **both** unless the user asks for only one. Always surface
the `status` line (busy vs idle/waiting) and the active-jobs count prominently —
that is the "what is Claude doing / waiting for" answer.
