#!/usr/bin/env node
/**
 * Elfura .env audit for the active four-source runtime.
 *
 * Usage (inside the Pterodactyl container, next to .env):
 *   node scripts/env-audit.mjs          # report only
 *   node scripts/env-audit.mjs --fix    # comment out disabled source flags, keep a .env.bak
 *   node scripts/env-audit.mjs --print  # print a minimal current .env
 *
 * Nothing here talks to the network and nothing is deleted without a backup.
 */
import fs from 'node:fs';
import path from 'node:path';

const ARGS = new Set(process.argv.slice(2));
const FILE = process.argv.slice(2).find((a) => !a.startsWith('-')) || '.env';

const SOURCE_FLAGS = {
  ELFURA_CITADEL_ENABLED: 'source-1 (Citadel/RiveStream)',
  ELFURA_GREYBOX_ENABLED: 'source-2 (Greybox)',
  ELFURA_NXSHA_ENABLED: 'source-3 (Nxsha)',
  ELFURA_VIDLY_ENABLED: 'source-4 (Vidly)',
};

const RECOMMENDED = `# Elfura backend — current four-source runtime
SERVER_PORT=8787
HOST=0.0.0.0
NODE_ENV=production
ELFURA_SECRET=
ALLOWED_ORIGINS=*
RELAY_MODE=hybrid
TMDB_API_KEY=

# source-1 (Citadel/RiveStream), source-2 (Greybox), source-3 (Nxsha),
# and source-4 (Vidly) are enabled by default. Disable only for debugging.
# ELFURA_CITADEL_ENABLED=0
# ELFURA_GREYBOX_ENABLED=0
# ELFURA_NXSHA_ENABLED=0
# ELFURA_VIDLY_ENABLED=0
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
  findings.push(`❌ ${disabled.length} active source(s) switched OFF: ` + disabled.map(d => `${d.label} (${d.flag}=0)`).join(', '));
}
if (!hasTmdb) findings.push('⚠️  no TMDB_API_KEY / TMDB_BEARER_TOKEN / TMDB_API_BASE — titles may resolve with empty metadata.');
if (!secret) findings.push('ℹ️  ELFURA_SECRET is empty — playback tickets stop working after each restart.');
const unknownSourceFlags = [...entries.keys()].filter(key => key.startsWith('ELFURA_') && key.endsWith('_ENABLED') && !Object.hasOwn(SOURCE_FLAGS, key));
if (unknownSourceFlags.length) findings.push(`ℹ️  ${unknownSourceFlags.length} unrecognized source flag(s) should be reviewed and removed.`);

console.log(`[env-audit] ${path.resolve(FILE)} — ${entries.size} keys read`);
if (ARGS.has('--fix') && disabled.length) {
  fs.writeFileSync(`${FILE}.bak`, raw);
  const stamp = new Date().toISOString().slice(0, 10);
  for (const item of disabled) {
    lines[item.index] = `# disabled ${stamp}: ${lines[item.index]}`;
  }
  fs.writeFileSync(FILE, `${lines.join('\n').replace(/\n+$/, '')}\n`);
  console.log(`[env-audit] commented ${disabled.length} disabled source flag(s); backup: ${FILE}.bak`);
}

if (!findings.length) {
  console.log('✓ no active source is disabled and TMDB is configured.');
} else {
  for (const finding of findings) console.log(finding);
}
