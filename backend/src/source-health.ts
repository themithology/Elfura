/**
 * Per-source health memory and operator kill switches.
 *
 * The problem this solves: when a provider changes its site, its adapter starts
 * failing. Nothing noticed, so it kept being called on every resolve, kept
 * spending the shared response budget on timeouts, and kept returning nothing —
 * for days. One broken source quietly degraded every title.
 *
 * Two mechanisms, deliberately separate:
 *
 *  - The operator switch (`setEnabled`) is absolute. If it is off, the adapter is
 *    never called. It persists to disk, because an operator who turned a source
 *    off during an incident should not have to remember to do it again after a
 *    restart.
 *
 *  - The automatic pause is a cooldown, not a verdict. After consecutive
 *    failures a source stops being called for a while, then gets one quiet
 *    attempt. A provider that fixes itself comes back on its own.
 *
 * State lives in `data/source-health.json`, which is small and bounded: one entry
 * per known source, at most a few dozen rows.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { ResolverSourceStatus } from './playback-resolver.js';

/** Failures in a row before a source is rested. */
const PAUSE_AFTER_FAILURES = Number(process.env.ELFURA_SOURCE_PAUSE_AFTER || 5);
/** How long a rested source is skipped before one quiet retry. */
const PAUSE_DURATION_MS = Number(process.env.ELFURA_SOURCE_PAUSE_MS || 30 * 60_000);
/** Cap so an extremely long outage does not park a source forever. */
const MAX_PAUSE_MS = 6 * 60 * 60_000;

interface SourceState {
  /** Operator switch. Absent means enabled. */
  disabled?: boolean;
  consecutiveFailures: number;
  successes: number;
  /** Epoch ms until which the source is rested. */
  retryAt?: number;
  lastError?: string;
  lastFailureAt?: number;
  lastSuccessAt?: number;
}

interface PersistedShape {
  sources?: Record<string, SourceState>;
}

export class SourceHealthStore {
  private readonly states = new Map<string, SourceState>();
  private readonly file: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private writeFailed = false;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'source-health.json');
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as PersistedShape;
      for (const [id, state] of Object.entries(parsed.sources ?? {})) {
        if (!state || typeof state !== 'object') continue;
        this.states.set(id, {
          disabled: state.disabled === true,
          consecutiveFailures: Number.isFinite(state.consecutiveFailures) ? Number(state.consecutiveFailures) : 0,
          successes: Number.isFinite(state.successes) ? Number(state.successes) : 0,
          retryAt: Number.isFinite(state.retryAt) ? Number(state.retryAt) : undefined,
          lastError: typeof state.lastError === 'string' ? state.lastError.slice(0, 200) : undefined,
          lastFailureAt: Number.isFinite(state.lastFailureAt) ? Number(state.lastFailureAt) : undefined,
          lastSuccessAt: Number.isFinite(state.lastSuccessAt) ? Number(state.lastSuccessAt) : undefined,
        });
      }
    } catch {
      /* no file yet, or unreadable: start clean; health state is not critical */
    }
  }

  private stateFor(id: string): SourceState {
    const existing = this.states.get(id);
    if (existing) return existing;
    const fresh: SourceState = { consecutiveFailures: 0, successes: 0 };
    this.states.set(id, fresh);
    return fresh;
  }

  /** Operator intent. This is the hard switch. */
  isEnabledByOperator(id: string): boolean {
    return this.states.get(id)?.disabled !== true;
  }

  /**
   * Should this source be called right now?
   *
   * False when the operator turned it off, or when it is resting after repeated
   * failures. An expired cooldown returns true and lets the next call decide.
   */
  shouldAttempt(id: string, now = Date.now()): boolean {
    const state = this.states.get(id);
    if (!state) return true;
    if (state.disabled) return false;
    if (state.retryAt && now < state.retryAt) return false;
    return true;
  }

  /** Record a successful resolve. Clears the failure streak and any rest. */
  recordSuccess(id: string, note?: string): void {
    const state = this.stateFor(id);
    state.consecutiveFailures = 0;
    state.successes += 1;
    state.retryAt = undefined;
    state.lastSuccessAt = Date.now();
    if (note !== undefined) state.lastError = undefined;
    this.scheduleSave();
  }

  /**
   * Record a failure. After enough in a row the source is rested with an
   * exponential cooldown, so a persistently broken provider costs less over time
   * while a briefly throttled one recovers on the next attempt.
   */
  recordFailure(id: string, error: string): void {
    const state = this.stateFor(id);
    state.consecutiveFailures += 1;
    state.lastError = error.slice(0, 200);
    state.lastFailureAt = Date.now();
    if (state.consecutiveFailures >= PAUSE_AFTER_FAILURES) {
      const over = state.consecutiveFailures - PAUSE_AFTER_FAILURES;
      const delay = Math.min(PAUSE_DURATION_MS * 2 ** Math.min(over, 4), MAX_PAUSE_MS);
      state.retryAt = Date.now() + delay;
    }
    this.scheduleSave();
  }

  /** Operator turns a source on or off. Persisted. */
  setEnabled(id: string, enabled: boolean): void {
    const state = this.stateFor(id);
    state.disabled = enabled ? false : true;
    if (enabled) {
      // Turning a source back on clears its rest and its streak: the operator
      // has decided to give it another chance, so do not immediately re-pause it.
      state.retryAt = undefined;
      state.consecutiveFailures = 0;
      state.lastError = undefined;
    }
    this.scheduleSave();
  }

  /** Forget a source's history entirely, e.g. after a deploy fixes an adapter. */
  reset(id?: string): void {
    if (id) {
      const kept = this.states.get(id);
      const disabled = kept?.disabled === true;
      this.states.set(id, { consecutiveFailures: 0, successes: 0, ...(disabled ? { disabled } : {}) });
    } else {
      for (const [key, state] of this.states) {
        this.states.set(key, { consecutiveFailures: 0, successes: 0, ...(state.disabled ? { disabled: true } : {}) });
      }
    }
    this.scheduleSave();
  }

  /**
   * Snapshot for the panel and the health endpoint.
   *
   * `known` lets a caller include sources this store has never seen so the panel
   * lists every configured source, not only the ones that have failed.
   */
  snapshot(known: { id: string; label: string }[] = []): ResolverSourceStatus[] {
    const now = Date.now();
    const rows: ResolverSourceStatus[] = [];
    const seen = new Set<string>();
    const push = (id: string, label: string) => {
      seen.add(id);
      const state = this.states.get(id);
      const disabled = state?.disabled === true;
      const restingUntil = state?.retryAt && state.retryAt > now ? state.retryAt : null;
      rows.push({
        id,
        label,
        disabledByOperator: disabled,
        paused: !disabled && restingUntil !== null,
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        retryAt: restingUntil,
        lastError: state?.lastError ?? null,
        successes: state?.successes ?? 0,
        detail: disabled
          ? 'turned off by the operator'
          : restingUntil
            ? `resting until ${new Date(restingUntil).toISOString()}`
            : state?.lastError
              ? `last error: ${state.lastError}`
              : 'healthy',
      });
    };
    for (const source of known) push(source.id, source.label);
    for (const [id] of this.states) if (!seen.has(id)) push(id, id);
    return rows;
  }

  /** Write-behind: a burst of resolves must not mean a burst of disk writes. */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 1_000);
    this.saveTimer.unref?.();
  }

  private save(): void {
    try {
      const sources: Record<string, SourceState> = {};
      for (const [id, state] of this.states) sources[id] = state;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ sources }, null, 0), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.writeFailed = false;
    } catch (error) {
      if (!this.writeFailed) {
        this.writeFailed = true;
        console.warn(
          `[elfura-health] could not save ${this.file}: ` +
            `${error instanceof Error ? error.message : 'unknown error'} (health state stays in memory)`,
        );
      }
    }
  }
}
