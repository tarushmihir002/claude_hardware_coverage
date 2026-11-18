// installSkill.js — copy the bundled claude-dashboard skill into the current
// PC's user skills dir (~/.claude/skills/claude-dashboard). Cross-platform.
// Usable as a module (installSkill) and as a CLI (`npm run install-skill`).
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'skill');

export function skillTargetDir() {
  return path.join(os.homedir(), '.claude', 'skills', 'claude-dashboard');
}

export function isSkillInstalled() {
  try { return fs.existsSync(path.join(skillTargetDir(), 'SKILL.md')); }
  catch { return false; }
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

export function installSkill() {
  const target = skillTargetDir();
  if (!fs.existsSync(SRC)) {
    throw new Error('Bundled skill folder not found at ' + SRC);
  }
  fs.mkdirSync(target, { recursive: true });
  // Node 16.7+: recursive copy.
  fs.cpSync(SRC, target, { recursive: true });
  return { ok: true, target, files: listFiles(target), installedAt: new Date().toISOString() };
}

// CLI entry.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = installSkill();
    console.log('✓ Installed claude-dashboard skill to:\n  ' + r.target);
    console.log('  files: ' + r.files.join(', '));
    console.log('\nRestart Claude Code (or /doctor) to pick it up, then run /claude-dashboard.');
  } catch (e) {
    console.error('✗ Install failed: ' + e.message);
    process.exit(1);
  }
}
