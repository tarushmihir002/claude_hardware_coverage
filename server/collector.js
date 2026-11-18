// collector.js — produce a snapshot of Claude Code's local activity.
// Windows: reuse the bundled, tested PowerShell collector (skill/scripts).
// macOS / Linux: a best-effort Node implementation using `ps` + nvidia-smi.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import readline from 'node:readline';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLLECT_PS1 = path.join(__dirname, '..', 'skill', 'scripts', 'collect.ps1');

// ---- secret redaction (mirrors the PowerShell _Redact) --------------------
function redact(s) {
  if (!s) return s;
  return String(s)
    .replace(/sk-or-v1-[a-z0-9]{10,}/gi, 'sk-or-v1-***REDACTED***')
    .replace(/sk-[a-z0-9]{20,}/gi, 'sk-***REDACTED***')
    .replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_***REDACTED***')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***REDACTED***')
    .replace(/AKIA[A-Z0-9]{12,}/g, 'AKIA***REDACTED***')
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/gi, 'xox-***REDACTED***')
    .replace(/(api[_\- ]?key["':=\s]{1,4})[A-Za-z0-9_\-]{16,}/gi, '$1***REDACTED***')
    .replace(/(bearer\s+)[A-Za-z0-9._\-]{16,}/gi, '$1***REDACTED***');
}

// ===========================================================================
// Windows path: run the bundled PowerShell collector.
// ===========================================================================
async function collectWindows() {
  const psExe = process.env.PWSH || 'powershell';
  const { stdout } = await execFileP(
    psExe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', COLLECT_PS1],
    { maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }
  );
  return JSON.parse(stdout.replace(/^﻿/, '').trim());
}

// ===========================================================================
// POSIX path (mac/linux): build an equivalent snapshot from `ps`.
// ===========================================================================
function classify(name, cmd) {
  const n = (name || '').toLowerCase();
  if (/^(node|claude)/.test(n)) return /claude/i.test(cmd) ? 'claude-engine' : 'node';
  if (/pwsh|powershell/.test(n)) return 'shell:pwsh';
  if (/^bash|\bsh$|zsh/.test(n)) return 'shell:bash';
  if (/git/.test(n)) return 'git';
  if (/rg|ripgrep/.test(n)) return 'search:rg';
  if (/python|^py/.test(n)) return 'python';
  if (/nvidia-smi/.test(n)) return 'probe:nvidia-smi';
  return name;
}

async function gpuInfo() {
  const gpus = [];
  const gpuProcMap = {};
  try {
    const { stdout } = await execFileP('nvidia-smi', [
      '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
      '--format=csv,noheader,nounits',
    ]);
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const p = line.split(',').map((x) => x.trim());
      gpus.push({
        index: +p[0], name: p[1], utilPct: parseInt(p[2]) || 0,
        memUsedMB: parseInt(p[3]) || 0, memTotalMB: parseInt(p[4]) || 0,
        tempC: p[5], powerW: p[6],
      });
    }
    const { stdout: ca } = await execFileP('nvidia-smi', [
      '--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits',
    ]);
    for (const line of ca.trim().split('\n')) {
      if (!line.trim()) continue;
      const p = line.split(',').map((x) => x.trim());
      gpuProcMap[+p[0]] = parseInt(p[1]) || 0;
    }
  } catch { /* no nvidia gpu */ }
  return { gpus, gpuProcMap };
}

async function collectPosix() {
  const now = new Date();
  const total = os.totalmem(), free = os.freemem();
  const system = {
    host: os.hostname(),
    cpuName: (os.cpus()[0] || {}).model || 'CPU',
    cpuCores: os.cpus().length,
    cpuLoadPct: Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100)),
    ramTotalMB: Math.round(total / 1048576),
    ramUsedMB: Math.round((total - free) / 1048576),
    ramUsedPct: Math.round(((total - free) / total) * 100),
  };

  const { gpus, gpuProcMap } = await gpuInfo();

  // ps: pid, ppid, rss(KB), elapsed(sec), %cpu, comm, full args
  const { stdout } = await execFileP('ps', ['-eo', 'pid=,ppid=,rss=,etimes=,pcpu=,comm=,args='], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const all = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    all.push({
      pid: +m[1], ppid: +m[2], rssKB: +m[3], etimes: +m[4], pcpu: parseFloat(m[5]) || 0,
      comm: path.basename(m[6]), args: m[7],
    });
  }
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const children = new Map();
  for (const p of all) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const roots = all.filter((p) => /claude/i.test(p.args) && /^(node|claude)/.test(p.comm)).map((p) => p.pid);
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const c of children.get(id) || []) stack.push(c);
  }
  const treeProcs = [...seen].map((id) => byPid.get(id)).filter(Boolean);
  const processes = treeProcs.map((p) => {
    const cmd = redact(p.args.length > 140 ? p.args.slice(0, 140) + '...' : p.args);
    return {
      pid: p.pid, ppid: p.ppid, name: p.comm, kind: classify(p.comm, p.args),
      ramMB: Math.round((p.rssKB / 1024) * 10) / 10, cpuSec: 0, runSec: p.etimes,
      gpuMemMB: gpuProcMap[p.pid] || 0, isSelf: p.pid === process.pid, cmd,
    };
  }).sort((a, b) => b.ramMB - a.ramMB);

  const engine = processes.filter((p) => p.kind === 'claude-engine');
  const treeRamMB = Math.round(processes.reduce((s, p) => s + p.ramMB, 0) * 10) / 10;
  const treeGpuMemMB = processes.reduce((s, p) => s + p.gpuMemMB, 0);
  // %cpu from ps is per-core; divide by cores for share of total capacity.
  const claudeCpuPct = Math.max(0, Math.round((treeProcs.reduce((s, p) => s + p.pcpu, 0) / system.cpuCores) * 10) / 10);
  const claudeRamPct = Math.round((treeRamMB / Math.max(system.ramTotalMB, 1)) * 100);
  const jobs = processes
    .filter((p) => !['claude-engine', 'console-host', 'probe:nvidia-smi', 'wmi'].includes(p.kind) && !p.isSelf)
    .map((p) => ({ ...p, longRunning: p.runSec > 10 }));

  const { events, sessionId, sessionFile } = readTranscript();
  const promptHistory = readHistory();
  const status = jobs.length
    ? `busy - ${jobs.length} active command(s) in the tree`
    : engine.length ? 'idle - engine up, awaiting your input' : 'no local Claude Code process detected';

  return {
    generatedAt: now.toISOString().slice(0, 19),
    status,
    note: 'Local Claude Code process tree only. The model itself runs in Anthropic cloud; GPU/RAM below are your machine + local CLI.',
    system, gpus, claudeEngine: engine, processes, treeRamMB, treeGpuMemMB,
    claudeCpuPct, claudeRamPct, jobs,
    scheduled: [],
    session: { id: sessionId, file: sessionFile, cwd: process.cwd() },
    events, promptHistory,
  };
}

// ---- transcript + history (cross-platform JS) -----------------------------
function newestTranscript() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let newest = null, newestTime = 0;
  try {
    for (const proj of fs.readdirSync(root)) {
      const dir = path.join(root, proj);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        const t = fs.statSync(full).mtimeMs;
        if (t > newestTime) { newestTime = t; newest = full; }
      }
    }
  } catch { /* none */ }
  return newest;
}

function readTranscript(limit = 40) {
  const file = newestTranscript();
  const events = [];
  let sessionId = null;
  if (file) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (const l of lines) {
        if (!l.trim()) continue;
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (!sessionId && o.sessionId) sessionId = o.sessionId;
        const ts = o.timestamp;
        const content = o.message && o.message.content;
        if (o.type === 'assistant' && Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'tool_use') {
              let d = c.input?.command || c.input?.file_path || c.input?.pattern || c.input?.prompt || '';
              d = String(d); if (d.length > 120) d = d.slice(0, 120) + '...';
              events.push({ time: ts, kind: 'tool', label: c.name, detail: redact(d) });
            }
          }
        } else if (o.type === 'user' && Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'text' && c.text) {
              let t = String(c.text); if (t.length > 120) t = t.slice(0, 120) + '...';
              events.push({ time: ts, kind: 'prompt', label: 'user prompt', detail: redact(t) });
            }
          }
        }
      }
    } catch { /* unreadable */ }
  }
  return { events: events.filter((e) => e.time).slice(-limit), sessionId, sessionFile: file };
}

function readHistory(limit = 25) {
  const hf = path.join(os.homedir(), '.claude', 'history.jsonl');
  const out = [];
  try {
    const lines = fs.readFileSync(hf, 'utf8').split('\n').filter((l) => l.trim()).slice(-limit);
    for (const l of lines) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      out.push({
        time: o.timestamp ? new Date(o.timestamp).toISOString().slice(0, 19) : null,
        display: redact(String(o.display || '')),
        project: o.project,
      });
    }
    out.reverse();
  } catch { /* none */ }
  return out;
}

export async function collect() {
  try {
    return process.platform === 'win32' ? await collectWindows() : await collectPosix();
  } catch (err) {
    return {
      generatedAt: new Date().toISOString().slice(0, 19),
      status: 'collector error',
      note: 'Snapshot failed: ' + (err && err.message ? err.message : String(err)),
      system: { host: os.hostname(), cpuName: '', cpuCores: 0, cpuLoadPct: 0, ramTotalMB: 0, ramUsedMB: 0, ramUsedPct: 0 },
      gpus: [], claudeEngine: [], processes: [], treeRamMB: 0, treeGpuMemMB: 0,
      claudeCpuPct: 0, claudeRamPct: 0,
      jobs: [], scheduled: [], session: {}, events: [], promptHistory: [], error: true,
    };
  }
}
