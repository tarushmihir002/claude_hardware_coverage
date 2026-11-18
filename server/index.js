// index.js — local backend: live SSE snapshot feed + skill installer + static UI.
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { collect } from './collector.js';
import { installSkill, isSkillInstalled, skillTargetDir } from './installSkill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const INTERVAL = Math.max(1000, Number(process.env.INTERVAL_MS) || 3000);
const DIST = path.join(__dirname, '..', 'dist');

const app = express();
app.use(express.json());

// ---- live feed: poll the collector, push to all SSE clients ---------------
const clients = new Set();
let latest = null;

async function tick() {
  try {
    latest = await collect();
    const payload = `data: ${JSON.stringify(latest)}\n\n`;
    for (const res of clients) res.write(payload);
  } catch (e) {
    // keep the loop alive; the collector already returns an error snapshot
  }
}
setInterval(tick, INTERVAL);
tick();

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    platform: process.platform,
    intervalMs: INTERVAL,
    skillInstalled: isSkillInstalled(),
    skillTarget: skillTargetDir(),
  });
});

app.get('/api/snapshot', async (req, res) => {
  res.json(latest || (await collect()));
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: ${INTERVAL}\n\n`);
  if (latest) res.write(`data: ${JSON.stringify(latest)}\n\n`);
  clients.add(res);
  const ka = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  req.on('close', () => { clearInterval(ka); clients.delete(res); });
});

app.post('/api/install-skill', (req, res) => {
  try {
    res.json(installSkill());
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- static UI (production build) -----------------------------------------
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(DIST, 'index.html'));
  });
}

app.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`\n  Claude Live Dashboard backend running`);
  console.log(`  platform : ${process.platform}   interval : ${INTERVAL}ms`);
  console.log(`  skill    : ${isSkillInstalled() ? 'installed' : 'not installed'} (${skillTargetDir()})`);
  if (fs.existsSync(DIST)) console.log(`  open     : ${url}`);
  else console.log(`  dev UI   : http://localhost:5173  (run \`npm run dev\`)  API: ${url}`);
  console.log('');
});
