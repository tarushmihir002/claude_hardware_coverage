# Claude Live Dashboard

A React + Node app that shows a **live feed** of what Claude Code is doing on
the machine it runs on, and can **install the `claude-dashboard` skill** onto
that machine with one click.

- **Live feed** — a local Node backend runs the collector every few seconds and
  streams snapshots to the browser over Server-Sent Events. The React dashboard
  updates in place: resource meters (CPU / RAM / GPU), the Claude process tree,
  active/background jobs, a session timeline, and prompt history.
- **Install the skill anywhere** — the app bundles the skill and copies it into
  `~/.claude/skills/claude-dashboard` on whatever PC the app runs on, from the
  UI button or `npm run install-skill`.
- **Secrets auto-redacted** — API keys/tokens in history or command lines are
  scrubbed before leaving the backend.

> **Scope / honesty:** the Claude *model* runs in Anthropic's cloud, so there is
> no local GPU/RAM used by the model itself. This measures the **local Claude
> Code process tree** plus the machine's overall CPU/RAM/GPU. Cloud *routines*
> (from the `schedule` skill) are not stored on disk and do not appear here.

## Requirements

- **Node.js 18+** (uses `fs.cpSync` and native `EventSource` isn't needed server-side).
- **Windows**: works out of the box (reuses the bundled PowerShell collector).
  Optional: NVIDIA GPU with `nvidia-smi` on PATH for GPU stats.
- **macOS / Linux**: best-effort collector via `ps` (+ `nvidia-smi` if present).

## Quick start (any PC)

```bash
npm install
npm start           # builds the UI and serves everything on http://localhost:8787
```

Open http://localhost:8787 and click **Install skill on this PC** if you also
want the `/claude-dashboard` skill available inside Claude Code.

### Development (hot reload)

```bash
npm run dev         # Vite UI on :5173 (proxies /api to the backend on :8787)
```

### Just install the skill, no UI

```bash
npm run install-skill
```

## Configuration (env vars)

| Var           | Default     | Meaning                                             |
|---------------|-------------|-----------------------------------------------------|
| `PORT`        | `8787`      | Backend / production UI port                        |
| `HOST`        | `127.0.0.1` | Bind address. Set `0.0.0.0` to view from the LAN    |
| `INTERVAL_MS` | `3000`      | How often the backend samples a new snapshot        |
| `PWSH`        | `powershell`| PowerShell executable (set to `pwsh` for PS 7)      |

Example — view from another device on your network, sampling every 2s:

```bash
HOST=0.0.0.0 INTERVAL_MS=2000 npm start
```

## HTTP API

- `GET  /api/health` — platform, interval, whether the skill is installed.
- `GET  /api/snapshot` — one snapshot (JSON).
- `GET  /api/stream` — SSE stream of snapshots (the live feed).
- `POST /api/install-skill` — copy the bundled skill into `~/.claude/skills/`.

## Layout

```
claude-live-dashboard/
  server/
    index.js         Express: SSE feed, snapshot, install, static UI
    collector.js     Windows (PowerShell) + POSIX (ps) snapshot, with redaction
    installSkill.js  Copies the bundled skill to ~/.claude/skills
  skill/             Bundled claude-dashboard skill (what gets installed)
  src/               React app (App.jsx, styles.css, main.jsx)
  index.html         Vite entry
```
