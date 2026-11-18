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
  // No memory flags needed is not a reason to skip supervision: a crash still
  // has to come back on its own.
  if (!flags.length && process.env.ELFURA_SUPERVISE === '0') return false;

  if (flags.length) {
    console.log(`[elfura-memory] starting with ${flags.join(' ')} to keep RAM flat in a small container`);
  }
  return supervise(flags);
}

/**
 * Restart the server when it exits, instead of exiting with it.
 *
 * The parent re-launched the child to apply memory flags, then forwarded the
 * child's exit straight to the host. So any crash - one bad request, an OOM, an
 * upstream socket doing something strange - ended the process, and the panel sat
 * there showing the server as offline until somebody restarted it by hand.
 *
 * Pterodactyl cannot restart what has already gone, but it keeps the process it
 * started: if that process stays alive and re-spawns its worker, the service
 * comes back on its own within a second.
 *
 * A deliberate shutdown never loops: a signal (panel stop, restart, host reboot)
 * is forwarded to the child and the supervisor then exits with it. The attempt
 * limiter stops a startup crash from spinning forever, which would otherwise
 * look like a healthy container while serving nothing.
 */
const RESTART_BASE_DELAY_MS = 700;
const RESTART_MAX_DELAY_MS = 30_000;
/** Consecutive fast failures before giving up, so a boot loop is visible. */
const MAX_QUICK_RESTARTS = 12;
/** A run longer than this counts as healthy and resets the backoff. */
const HEALTHY_RUN_MS = 30_000;

function supervise(flags) {
  let stopping = false;
  let quickRestarts = 0;
  let timer = null;

  const start = () => {
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      [...inheritableExecArgv(), ...flags, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, [REENTRY_FLAG]: '1' } },
    );

    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      process.on(sig, () => {
        stopping = true;
        if (timer) clearTimeout(timer);
        child.kill(sig);
      });
    }

    child.on('exit', (code, signal) => {
      if (stopping) {
        // A signal in flight means the host asked for this; pass it through and
        // let the supervisor finish rather than resurrecting the worker.
        if (signal) process.kill(process.pid, signal);
        else process.exit(code ?? 0);
        return;
      }

      const ranFor = Date.now() - startedAt;
      if (ranFor >= HEALTHY_RUN_MS) quickRestarts = 0;
      else quickRestarts += 1;

      if (quickRestarts > MAX_QUICK_RESTARTS) {
        console.error(
          `[elfura-supervisor] the server failed ${quickRestarts} times in a row without staying up ` +
            `(last exit code ${code}, signal ${signal ?? 'none'}). Giving up so the failure is visible ` +
            `in the panel instead of looping silently. Fix the start-up error above, then restart.`,
        );
        process.exit(code ?? 1);
        return;
      }

      const delay = Math.min(RESTART_MAX_DELAY_MS, RESTART_BASE_DELAY_MS * 2 ** Math.max(0, quickRestarts - 1));
      console.error(
        `[elfura-supervisor] server exited unexpectedly (code ${code}, signal ${signal ?? 'none'}) ` +
          `after ${Math.round(ranFor / 1000)}s; restarting in ${delay}ms ` +
          `(attempt ${quickRestarts}/${MAX_QUICK_RESTARTS})`,
      );
      timer = setTimeout(start, delay);
    });
  };

  start();
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
  // `node index.js --resolver` runs the source resolver instead of the media
  // server: same build, separate port, separate memory. The flag is stripped
  // before the backend sees argv, so both modes read identical options.
  const wantsResolver =
    process.argv.includes('--resolver') || process.env.ELFURA_RESOLVER_MODE === '1';
  const args = process.argv.slice(2).filter((arg) => arg !== '--resolver');
  process.argv = [process.argv[0], process.argv[1], ...args];
  const backend = await import('./dist/backend/index.js');
  if (wantsResolver) {
    backend.startResolverServer();
  } else {
    backend.startBackendServer();
  }
}
