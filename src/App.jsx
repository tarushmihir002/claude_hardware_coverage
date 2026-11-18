import React, { useEffect, useRef, useState, useCallback } from 'react';

/* ---------- helpers ---------- */
const lvl = (p) => (p >= 85 ? 'crit' : p >= 60 ? 'warn' : 'ok');
const dur = (s) => {
  s = +s || 0;
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
  if (s < 86400) return Math.floor(s / 3600) + 'h' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm';
  return Math.floor(s / 86400) + 'd' + String(Math.floor((s % 86400) / 3600)).padStart(2, '0') + 'h';
};
const fmtTime = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return iso; } };
const fmtDT = (iso) => { try { const d = new Date(iso); return d.toLocaleDateString([], { month: 'short', day: '2-digit' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };
const kindClass = (k) => (/engine/.test(k) ? 'engine' : /shell/.test(k) ? 'shell' : '');
const baseName = (p) => (p || '').split(/[\\/]/).pop();

/* ---------- live SSE feed hook ---------- */
function useLiveFeed() {
  const [data, setData] = useState(null);
  const [conn, setConn] = useState('wait'); // wait | live | down
  const esRef = useRef(null);

  useEffect(() => {
    let closed = false;
    function connect() {
      const es = new EventSource('/api/stream');
      esRef.current = es;
      es.onopen = () => !closed && setConn('live');
      es.onmessage = (e) => {
        if (closed) return;
        try { setData(JSON.parse(e.data)); setConn('live'); } catch {}
      };
      es.onerror = () => {
        if (closed) return;
        setConn('down');
        // EventSource auto-reconnects; reflect waiting state.
        setTimeout(() => !closed && setConn((c) => (c === 'down' ? 'wait' : c)), 1200);
      };
    }
    connect();
    return () => { closed = true; esRef.current && esRef.current.close(); };
  }, []);

  return { data, conn };
}

/* ---------- small components ---------- */
function Meter({ k, v, unit, p, sub, scope }) {
  return (
    <div className="meter">
      <div className="lbl">
        <span className="kwrap"><span className="k">{k}</span>{scope && <span className={'scope ' + scope}>{scope}</span>}</span>
        <span className="v">{v}{unit ? <small> {unit}</small> : null}</span>
      </div>
      <div className="track"><div className={'fill ' + lvl(p)} style={{ width: Math.min(100, p) + '%' }} /></div>
      <span className="sub2">{sub}</span>
    </div>
  );
}

function SectionH({ title, count }) {
  return (
    <div className="section-h">
      <h2>{title}</h2>
      {count != null && <span className="ct">{count}</span>}
      <span className="rule" />
    </div>
  );
}

/* ---------- install button ---------- */
function InstallButton({ onResult }) {
  const [busy, setBusy] = useState(false);
  const click = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/install-skill', { method: 'POST' });
      const j = await r.json();
      onResult(j.ok ? { ok: true, msg: `Skill installed to ${j.target}`, files: j.files } : { ok: false, msg: j.error || 'Install failed' });
    } catch (e) {
      onResult({ ok: false, msg: 'Request failed: ' + e.message });
    } finally { setBusy(false); }
  };
  return (
    <button className="btn primary" onClick={click} disabled={busy}>
      {busy ? 'Installing…' : '⇩ Install skill on this PC'}
    </button>
  );
}

/* ---------- main ---------- */
export default function App() {
  const { data, conn } = useLiveFeed();
  const [health, setHealth] = useState(null);
  const [toast, setToast] = useState(null);

  const loadHealth = useCallback(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => {});
  }, []);
  useEffect(() => { loadHealth(); }, [loadHealth]);

  const onInstall = (res) => {
    setToast(res);
    loadHealth();
    setTimeout(() => setToast(null), 9000);
  };

  if (!data) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div>Connecting to local backend…</div>
      </div>
    );
  }

  const d = data;
  const busy = /busy/.test(d.status), off = /no local/.test(d.status), err = d.error || /error/.test(d.status);
  const statusClass = err ? 'err' : off ? 'off' : busy ? 'busy' : 'idle';
  const sys = d.system, g = (d.gpus && d.gpus[0]) || null;

  // Claude-only footprint.
  const claudeCpu = typeof d.claudeCpuPct === 'number' ? d.claudeCpuPct : null;
  const claudeRam = typeof d.claudeRamPct === 'number'
    ? d.claudeRamPct
    : Math.round((d.treeRamMB / Math.max(sys.ramTotalMB, 1)) * 100);
  const claudeMeters = [
    { k: 'Claude CPU', scope: 'claude', v: claudeCpu == null ? '—' : claudeCpu + '%', p: claudeCpu || 0,
      sub: `${d.processes.length} procs · % of ${sys.cpuCores} cores` },
    { k: 'Claude RAM', scope: 'claude', v: claudeRam + '%', p: claudeRam,
      sub: `${Math.round(d.treeRamMB).toLocaleString()} MB · ${d.claudeEngine.length} engine · GPU ${d.treeGpuMemMB} MB` },
  ];

  // Whole-machine context.
  const systemMeters = [
    { k: 'CPU load', scope: 'system', v: sys.cpuLoadPct + '%', p: sys.cpuLoadPct, sub: `${sys.cpuName} · ${sys.cpuCores} cores` },
    { k: 'System RAM', scope: 'system', v: sys.ramUsedPct + '%', p: sys.ramUsedPct, sub: `${sys.ramUsedMB.toLocaleString()} / ${sys.ramTotalMB.toLocaleString()} MB` },
  ];
  if (g) {
    const memP = Math.round((g.memUsedMB / Math.max(g.memTotalMB, 1)) * 100);
    systemMeters.push({ k: 'GPU util', scope: 'system', v: g.utilPct + '%', p: g.utilPct, sub: `${g.name} · ${g.tempC}°C` });
    systemMeters.push({ k: 'GPU memory', scope: 'system', v: memP + '%', p: memP, sub: `${g.memUsedMB.toLocaleString()} / ${g.memTotalMB.toLocaleString()} MB` });
  }

  return (
    <>
      <header className="top">
        <div className="top-inner">
          <div className="brand">
            <h1>Claude Live Dashboard</h1>
            <span className="sub">
              Real-time local activity {health ? `· ${health.platform}` : ''}
              {' · '}skill {health?.skillInstalled ? 'installed ✓' : 'not installed'}
            </span>
          </div>
          <span className={'conn ' + conn}><span className="dot" />{conn === 'live' ? 'live' : conn === 'down' ? 'reconnecting' : 'connecting'}</span>
          <span className={'pill ' + statusClass}><span className="dot" />{d.status}</span>
          <InstallButton onResult={onInstall} />
        </div>
      </header>

      <div className="wrap">
        {toast && (
          <div className={'toast ' + (toast.ok ? 'ok' : 'bad')}>
            {toast.ok ? '✓ ' : '✗ '}{toast.msg}
            {toast.ok && <div style={{ marginTop: 6 }}>Restart Claude Code to pick it up, then run <code>/claude-dashboard</code>.</div>}
          </div>
        )}

        <div className="note">
          <span>ⓘ</span>
          <span><b>Scope.</b> {d.note}</span>
        </div>

        <SectionH title="Claude footprint" />
        <div className="meters">{claudeMeters.map((m, i) => <Meter key={i} {...m} />)}</div>
        <SectionH title="System context" />
        <div className="meters">{systemMeters.map((m, i) => <Meter key={i} {...m} />)}</div>

        <div className="cols">
          <div>
            <SectionH title="Process tree" count={`${d.processes.length} total`} />
            <div className="card tbl-scroll">
              <table>
                <thead><tr><th>PID</th><th>Kind</th><th className="num">RAM MB</th><th className="num">CPU s</th><th className="num">Uptime</th><th>Command</th></tr></thead>
                <tbody>
                  {d.processes.map((p) => (
                    <tr key={p.pid} className={p.isSelf ? 'self' : ''}>
                      <td className="num">{p.pid}</td>
                      <td><span className={'kind ' + kindClass(p.kind)}>{p.kind}</span>{p.isSelf && <span className="selftag">THIS</span>}</td>
                      <td className="num">{p.ramMB.toLocaleString()}</td>
                      <td className="num">{p.cpuSec.toLocaleString()}</td>
                      <td className="num">{dur(p.runSec)}</td>
                      <td className="cmd" title={p.cmd}>{p.cmd}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <SectionH title="Active jobs" count={d.jobs.length} />
            <div className="card">
              <div className="joblist">
                {d.jobs.length ? d.jobs.map((j) => (
                  <div className="job" key={j.pid}>
                    <span className="jk">{j.kind}</span>
                    <div className="jm">
                      <div className="jc" title={j.cmd}>{j.cmd}</div>
                      <div className="jt"><span>pid {j.pid}</span><span>· up {dur(j.runSec)}</span>{j.longRunning && <span className="badge">long-running</span>}</div>
                    </div>
                  </div>
                )) : <div className="empty">No spawned commands running — Claude is idle or awaiting input.</div>}
              </div>
            </div>

            <SectionH title="Scheduled" />
            <div className="card">
              {d.scheduled && d.scheduled.length ? d.scheduled.map((t, i) => (
                <div className="job" key={i}>
                  <span className="jk">task</span>
                  <div className="jm"><div className="jc">{t.name}</div><div className="jt"><span>{t.state}</span><span>· next {t.nextRun}</span></div></div>
                </div>
              )) : <div className="empty">No OS scheduled tasks match "claude". Cloud routines aren't stored locally — manage them with the schedule skill.</div>}
            </div>
          </div>
        </div>

        <SectionH title="Session timeline" count={`${d.events.length} events`} />
        <div className="card" style={{ padding: '12px 16px' }}>
          <div className="timeline">
            {d.events.slice().reverse().map((e, i) => (
              <div className={'ev ' + e.kind} key={i}>
                <span className="et">{fmtTime(e.time)}</span>
                <span className="el">{e.label}</span>
                <span className="ed" title={e.detail}>{e.detail}</span>
              </div>
            ))}
          </div>
        </div>

        <SectionH title="Prompt history" count={d.promptHistory.length} />
        <div className="card">
          <div className="hist">
            {d.promptHistory.map((h, i) => (
              <div className="hrow" key={i}>
                <span className="ht">{fmtDT(h.time)}</span>
                <span className={'hd ' + (/^\//.test(h.display || '') ? 'cmd' : '')} title={h.display}>{h.display}</span>
                <span className="hp" title={h.project}>{baseName(h.project)}</span>
              </div>
            ))}
          </div>
        </div>

        <footer>
          Streaming live from the local backend over SSE{health ? ` every ${Math.round(health.intervalMs / 1000)}s` : ''}.
          Secrets are auto-redacted. Install target: <code>{health?.skillTarget || '~/.claude/skills/claude-dashboard'}</code>
        </footer>
      </div>
    </>
  );
}
