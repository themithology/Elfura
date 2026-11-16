/**
 * Elfura — Root Entrypoint for Pterodactyl Node.js Eggs
 * =====================================================
 * Works out-of-the-box whether Pterodactyl's startup file is set to `index.js`,
 * `dist/backend/index.js`, or `npm start` — with zero runtime npm dependencies.
 *
 * Two things happen before the server is imported:
 *
 *  1. The process re-launches itself once with memory flags suited to a small
 *     container (see `reexecForMemory` for the measurements).
 *  2. If this file was started by a TypeScript runner (ts-node, tsx, tsimp),
 *     the server is imported from the compiled `dist/` build and the runner is
 *     left behind. That matters because some Pterodactyl eggs hard-code
 *     `ts-node --esm index.ts` or similar; this file is plain JavaScript, and it
 *     must never depend on a TypeScript toolchain being installed to work.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REENTRY_FLAG = 'ELFURA_MEMORY_FLAGS_APPLIED';

/** Flags a TypeScript runner injects into `process.execArgv`. */
const RUNNER_ARG_PREFIXES = ['--require', '--loader', '--import', '--experimental-loader'];
const RUNNER_PATH_MARKERS = ['ts-node', 'tsx', 'tsimp', '/node_modules/.bin/'];

/**
 * Is Node running under a TypeScript runner rather than as plain `node`?
 *
 * Detected from `process.execArgv`, not from the file extension: this entrypoint
 * is `.js` even when an egg starts it through ts-node, and ts-node's own
 * bootstrap flags are the reliable signal.
 */
function underTypeScriptRunner() {
  return process.execArgv.some((arg, index) => {
    if (RUNNER_ARG_PREFIXES.includes(arg)) {
      const value = process.execArgv[index + 1] ?? '';
      return RUNNER_PATH_MARKERS.some((marker) => value.includes(marker));
    }
    return RUNNER_PATH_MARKERS.some((marker) => arg.includes(marker));
  });
}

/** Only the flags this process actually needs from its parent — never a runner's. */
function inheritableExecArgv() {
  return process.execArgv.filter((arg) => {
    if (RUNNER_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix))) return false;
    if (RUNNER_PATH_MARKERS.some((marker) => arg.includes(marker))) return false;
    // ts-node passes its compiled config as an opaque blob; forwarding it makes
    // Node try to resolve it as a path.
    if (arg.startsWith('--brotli-base64-config')) return false;
    return arg.startsWith('--');
  });
}

/**
 * Relaunch once with V8 memory flags that suit a small container.
 *
 * V8 grows its heap lazily because nothing tells it the host is small. Measured
 * on this backend under sustained traffic: live heap stayed flat around 15 MB
 * while RSS climbed past 130 MB — V8's committed space, not a leak. A hard
 * ceiling makes it collect instead of grow, and capping the young generation
 * stops short-lived request buffers from ballooning it.
 *
 * Returns true when this process handed over to a child and must do nothing else.
 */
function reexecForMemory() {
  // Only the process the host started may re-launch itself; the child inherits
  // the flag and goes straight to the server.
  if (process.env[REENTRY_FLAG] === '1') return false;

  const flags = [];
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
    [...inheritableExecArgv(), ...flags, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
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

/**
 * Warn if the place this process was started from still contains TypeScript
 * entrypoints. Older zips shipped them, and a Pterodactyl egg that finds
 * `index.ts` will happily try to run it through ts-node — which is how this
 * project ends up failing to boot for a reason that has nothing to do with it.
 * Stale files in an existing container are the common case, since unarchiving
 * over an old install does not delete what the old zip put there.
 */
async function warnAboutStaleTypeScriptEntrypoints() {
  const { readdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const root = dirname(fileURLToPath(import.meta.url));
  const names = ['index.ts', 'server.ts', 'app.ts', 'main.ts', 'bot.ts', 'start.ts'];
  try {
    const present = (await readdir(root)).filter((name) => names.includes(name));
    if (present.length) {
      console.warn(
        `[elfura-backend] stale TypeScript entrypoint(s) found next to this file: ${present.join(', ')}. ` +
          'Delete them so your panel cannot start this project through ts-node. ' +
          'The startup file should be index.js.',
      );
    }
  } catch {
    /* a read failure here is not worth failing boot over */
  }
}

// The parent exists only to hold the child; starting a server here too would
// bind the same port twice, so it does nothing but supervise.
if (!reexecForMemory()) {
  if (underTypeScriptRunner()) {
    console.log(
      '[elfura-backend] started through a TypeScript runner; serving the compiled build in dist/ ' +
        '(no TypeScript compiler is needed at runtime)',
    );
  }
  await warnAboutStaleTypeScriptEntrypoints();
  const { startBackendServer } = await import('./dist/backend/index.js');
  startBackendServer();
}
