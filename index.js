/**
 * Elfura — Root Entrypoint for Pterodactyl Node.js Eggs
 * =====================================================
 * Works out-of-the-box whether Pterodactyl's startup file is set to `index.js`,
 * `dist/backend/index.js`, or `npm start` — with zero runtime npm dependencies.
 *
 * One thing happens before the server is imported: the process re-launches
 * itself once with memory flags that suit a small container. See the comment on
 * `reexecForMemory` for why, with measurements.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REENTRY_FLAG = 'ELFURA_MEMORY_FLAGS_APPLIED';

function reexecForMemory() {
  let relaunched = false;
  // Only the process the host started may re-launch itself; the child inherits
  // the flag and goes straight to the server.
  if (process.env[REENTRY_FLAG] === '1') return false;

  const flags = [];
  // V8 grows its heap lazily because nothing tells it the host is small. Measured
  // on this backend under sustained traffic: live heap stayed flat around 15 MB
  // while RSS climbed past 120 MB — V8's committed space, not a leak. A hard
  // ceiling makes it collect instead of grow, and capping the young generation
  // stops short-lived request buffers from ballooning it in the first place.
  if (!process.execArgv.some((arg) => arg.startsWith('--max-old-space-size'))) {
    const mb = Number(process.env.ELFURA_MAX_OLD_SPACE_MB || 384);
    if (Number.isFinite(mb) && mb >= 128) flags.push(`--max-old-space-size=${Math.round(mb)}`);
  }
  if (!process.execArgv.some((arg) => arg.startsWith('--max-semi-space-size'))) {
    flags.push('--max-semi-space-size=16');
  }
  if (!flags.length) return false;

  console.log(`[elfura-memory] starting with ${flags.join(' ')} to keep RAM flat in a small container`);
  const child = spawn(
    process.execPath,
    [...process.execArgv, ...flags, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, [REENTRY_FLAG]: '1' } },
  );
  // The parent exists only to supervise: if the server dies, the host sees it.
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => child.kill(sig));
  }
  return true;
}

// The parent exists only to hold the child; starting a server here too would
// bind the same port twice, so it does nothing but supervise.
if (!reexecForMemory()) {
  const { startBackendServer } = await import('./dist/backend/index.js');
  startBackendServer();
}
