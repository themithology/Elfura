/**
 * Per-source health memory and operator kill switches.
 *
 * The problem this solves: when a provider changes its site, its adapter starts
 * failing. Nothing noticed, so it kept being called on every resolve, kept
 * spending the shared response budget on timeouts, and kept returning nothing —
 * for days. One broken source quietly degraded every title.
 *
 * What this does about it: **nothing automatic**. It records the failure and
 * shows it in the control panel, and that is the end of it.
 *
 *  - There is no automatic pause, no cooldown, no benching, no "resting". A
 *    source is called on every resolve unless a human turns it off. This is
 *    deliberate and was an explicit instruction: an automatic rule cannot tell
 *    "this site is dead" from "this site is throttling us for a minute", and it
 *    only takes one wrong guess to make a working source disappear.
 *
 *  - The operator switch (`setEnabled`) is the only thing that removes a source
 *    from rotation. It persists to disk, because an operator who turned a source
 *    off during an incident should not have to remember to do it again after a
 *    restart.
 *
 * State lives in `data/source-health.json`, which is small and bounded: one entry
 * per known source, at most a few dozen rows.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { ResolverSourceStatus } from './playback-resolver.js';

interface SourceState {
  /** Operator switch. Absent means enabled. */
  disabled?: boolean;
  consecutiveFailures: number;
  successes: number;
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
  /**
   * Whether a source may be called. Only an operator switch can say no.
   * Kept as a method (rather than reading state at the call site) so the rule has
   * exactly one home and a future change cannot quietly reintroduce a cooldown.
   */
  shouldAttempt(id: string): boolean {
    return this.states.get(id)?.disabled !== true;
  }

  /** Record a successful resolve. Clears the failure streak. */
  recordSuccess(id: string, note?: string): void {
    const state = this.stateFor(id);
    state.consecutiveFailures = 0;
    state.successes += 1;
    state.lastSuccessAt = Date.now();
    if (note !== undefined) state.lastError = undefined;
    this.scheduleSave();
  }

  /**
   * Record a failure. That is all: count it, remember the error, save it for the
   * panel. The source is still called on the next resolve, because a failure here
   * is evidence to show a human, not a verdict to act on automatically.
   */
  recordFailure(id: string, error: string): void {
    const state = this.stateFor(id);
    state.consecutiveFailures += 1;
    state.lastError = error.slice(0, 200);
    state.lastFailureAt = Date.now();
    this.scheduleSave();
  }

  /** Operator turns a source on or off. Persisted. */
  setEnabled(id: string, enabled: boolean): void {
    const state = this.stateFor(id);
    state.disabled = enabled ? false : true;
    if (enabled) {
      // The operator has decided to give it another chance, so start the
      // scorecard fresh rather than showing yesterday's failures forever.
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
    const rows: ResolverSourceStatus[] = [];
    const seen = new Set<string>();
    const push = (id: string, label: string) => {
      seen.add(id);
      const state = this.states.get(id);
      const disabled = state?.disabled === true;
      const failures = state?.consecutiveFailures ?? 0;
      rows.push({
        id,
        label,
        disabledByOperator: disabled,
        // Always false now: nothing pauses itself. Kept in the shape so an old
        // data file or an older client cannot misread a field.
        paused: false,
        consecutiveFailures: failures,
        retryAt: null,
        lastError: state?.lastError ?? null,
        successes: state?.successes ?? 0,
        detail: disabled
          ? 'turned off by the operator'
          : failures
            ? `failing · ${failures} in a row · last error: ${state?.lastError ?? 'unknown'}`
            : state?.successes
              ? 'healthy'
              : 'not tried yet',
      });
    };
    for (const source of known) push(source.id, source.label);
    // Do NOT replay ids the current build does not ship. A source-health file
    // outlives the code that wrote it: when a provider is dropped, renamed, or
    // two rows merge into one, the old ids stay on disk forever and this loop
    // used to turn each one into a permanent phantom row in the panel — an
    // id that nothing can resolve, cannot be switched off from the UI, and is
    // counted as if it were a working source. `known` is the authoritative
    // board; state for anything else is dead weight and is pruned on save.
    for (const id of [...this.states.keys()]) {
      if (!seen.has(id)) this.states.delete(id);
    }
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
