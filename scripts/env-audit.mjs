#!/usr/bin/env node
/**
 * Elfura .env audit
 * =================
 * Answers two questions every install eventually asks:
 *   1. "Is anything in my .env quietly switching a source off?"
 *   2. "What should this file actually contain?"
 *
 * Usage (inside the Pterodactyl container, next to .env):
 *   node scripts/env-audit.mjs            # report only
 *   node scripts/env-audit.mjs --fix      # comment out source switches, keep a .env.bak
 *   node scripts/env-audit.mjs --print    # print the minimal recommended .env
 *
 * Nothing here talks to the network and nothing is deleted without a backup.
 */
import fs from 'node:fs';
import path from 'node:path';

const ARGS = new Set(process.argv.slice(2));
const FILE = process.argv.slice(2).find((a) => !a.startsWith('-')) || '.env';

/** Source switches: present and set to 0 means that source is not racing. */
const SOURCE_FLAGS = {
  SOURCE1_ENABLED: 'Source 1',
  SOURCE3_ENABLED: 'Source 3',
  ELFURA_BINGR_ENABLED: 'Source 4',
  ELFURA_NXSHA_ENABLED: 'Source 5',
  ELFURA_SCREENSCAPE_ENABLED: 'Source 7',
  ELFURA_VIDZEE_ENABLED: 'Source 8',
  ELFURA_VIXSRC_ENABLED: 'Source 9',
  ELFURA_VIDNEST_ENABLED: 'Source 10',
  ELFURA_VAPLAYER_ENABLED: 'Source 11',
  ELFURA_VIDZEN_ENABLED: 'Source 12',
  ELFURA_XPASS_ENABLED: 'Source 13',
  ELFURA_RIVE_CITADEL_ENABLED: 'Source 14',
  ELFURA_MAPPLE_ENABLED: 'Source 15',
  ELFURA_ANIVEXA_ENABLED: 'Source 16',
  ELFURA_ANIVORTEX_ENABLED: 'Source 17',
  ELFURA_SUBDUB_ENABLED: 'Source 18',
  ELFURA_DESIDUB_ENABLED: 'Source 19',
  ELFURA_VIDORA_ENABLED: 'Source 20',
  ELFURA_WATCHOUT_ENABLED: 'Source 21 (Vidout)',
};

const RECOMMENDED = `# Elfura backend — minimal .env
# Every source is ON by default. Do not add per-source switches.

SERVER_PORT=8787
HOST=0.0.0.0
NODE_ENV=production

# Signs playback tickets. Empty = a new random secret each boot (links stop
# working after a restart). Generate once with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ELFURA_SECRET=

ALLOWED_ORIGINS=*


# TMDB is the only thing the app genuinely needs.
TMDB_API_KEY=

# Optional, all commented out:
# ELFURA_ANIVORTEX_INSTALL_ID=
# ELFURA_ANIVORTEX_KEY_ID=
# ELFURA_ANIVORTEX_PRIVATE_KEY=
# ELFURA_DEBUG_SOURCES=1
# ELFURA_RUNTIME_GUARD=1
# ELFURA_RESOLVE_BUDGET_MS=4600
`;

if (ARGS.has('--print')) {
  process.stdout.write(RECOMMENDED);
  process.exit(0);
}

if (!fs.existsSync(FILE)) {
  console.error(`[env-audit] no ${path.resolve(FILE)} found — create one from .env.example first.`);
  process.exit(1);
}

const raw = fs.readFileSync(FILE, 'utf8');
const lines = raw.split(/\r?\n/);
const entries = new Map();
lines.forEach((line, index) => {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m) entries.set(m[1], { value: m[2].trim().replace(/^["']|["']$/g, ''), index });
});

const findings = [];
const disabled = [];

for (const [flag, label] of Object.entries(SOURCE_FLAGS)) {
  const hit = entries.get(flag);
  if (hit && hit.value === '0') disabled.push({ flag, label, index: hit.index });
}

const hasTmdb = Boolean(entries.get('TMDB_API_KEY')?.value || entries.get('TMDB_BEARER_TOKEN')?.value || entries.get('TMDB_API_BASE')?.value);
const secret = entries.get('ELFURA_SECRET')?.value ?? '';

if (disabled.length) {
  findings.push(
    `❌ ${disabled.length} source(s) switched OFF in this file: ` +
      disabled.map((d) => `${d.label} (${d.flag}=0)`).join(', '),
  );
}
if (!hasTmdb) findings.push('⚠️  no TMDB_API_KEY / TMDB_BEARER_TOKEN — titles will resolve with empty metadata.');
if (!secret) findings.push('ℹ️  ELFURA_SECRET is empty — playback links stop working after each restart.');

// Anything mentioning a known upstream host is a configuration smell: sources
// are meant to be self-contained, and domains must never leak to browsers.
const SUSPECT_KEYS = [...entries.keys()].filter((k) => /^(ELFURA_)?(VIDOUT|WATCHOUT|FLIXFUN|AETHOFLIX|VIDARA|OFC)_/i.test(k));
if (SUSPECT_KEYS.length) findings.push(`ℹ️  unused/legacy keys present: ${SUSPECT_KEYS.join(', ')}`);

console.log(`[env-audit] ${path.resolve(FILE)} — ${entries.size} keys read`);

if (ARGS.has('--fix') && disabled.length) {
  fs.writeFileSync(`${FILE}.bak`, raw);
  const stamp = new Date().toISOString().slice(0, 10);
  for (const d of disabled) {
    // Commenting the line restores the default: sources are always on unless a
    // human deliberately switches one off.
    lines[d.index] = `# ${lines[d.index].trim()}   [env-audit ${stamp}: switched back on; sources default on]`;
  }
  fs.writeFileSync(FILE, lines.join('\n'));
  console.log(`[env-audit] --fix: commented out ${disabled.length} source switch(es); original kept as ${FILE}.bak`);
  console.log('[env-audit] restart the server for the change to take effect.');
} else if (disabled.length) {
  console.log('[env-audit] re-run with --fix to comment those lines out automatically.');
}

if (findings.length) {
  for (const line of findings) console.log(`           ${line}`);
} else {
  console.log('           ✅ nothing is switched off.');
}

console.log('\n[env-audit] recommended baseline (`node scripts/env-audit.mjs --print`):\n');
process.stdout.write(
  RECOMMENDED.split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') || l.startsWith('# Elfura backend') || l.startsWith('# TMDB') || l.startsWith('# Signs'))
    .join('\n') + '\n',
);
