import { cachedCandidateEvidence } from './liveness.js';
import type { RawStreamCandidate, SourceAdapter } from './types.js';

export interface CandidateEntry { adapter: SourceAdapter; candidate: RawStreamCandidate }
export const MAX_SINGLE_TRACK_FALLBACKS = 2;

/** Keep only manifest-proven multilingual streams, plus a tiny diverse fallback pool.
 * A manifest/child check is evidence of reachability, not proof of full playback. */
export function selectPlaybackCandidates(entries: CandidateEntry[]): CandidateEntry[] {
  const unique = new Set<string>();
  const multi: CandidateEntry[] = [];
  const single: (CandidateEntry & { alive: boolean; latency: number; host: string; order: number })[] = [];
  for (const entry of entries) {
    const c = entry.candidate;
    if (unique.has(c.url)) continue;
    unique.add(c.url);
    const evidence = cachedCandidateEvidence(c);
    const langs = [...new Set(evidence?.discoveredAudioLangs ?? [])];
    if (evidence?.alive && langs.length > 1) {
      multi.push({ adapter:entry.adapter, candidate:{...c,multiAudio:true,availableAudioLangs:langs,audioLang:undefined,audioLabel:undefined} });
      continue;
    }
    // Never promote upstream metadata, a timed-out probe, or multiple copies of
    // the same language into a supposedly multilingual source.
    let host = '';
    try { host = new URL(c.url).hostname.toLowerCase(); } catch { continue; }
    single.push({adapter:entry.adapter,candidate:{...c,multiAudio:false,availableAudioLangs:langs.length===1?langs:undefined},
      alive:!!evidence?.alive,latency:evidence?.rttMs ?? c.latencyMs ?? Number.POSITIVE_INFINITY,host,order:single.length});
  }
  single.sort((a,b)=>Number(b.alive)-Number(a.alive)||a.latency-b.latency||a.order-b.order);
  const selected: typeof single = [];
  const hosts = new Set<string>();
  // A verified candidate always beats an unknown one. Within each confidence
  // class, prefer independent hosts before taking a second from one host.
  for (const alive of [true, false]) {
    const tier = single.filter(item => item.alive === alive);
    for (const item of tier) {
      if (selected.length >= MAX_SINGLE_TRACK_FALLBACKS) break;
      if (hosts.has(item.host)) continue;
      selected.push(item); hosts.add(item.host);
    }
    for (const item of tier) {
      if (selected.length >= MAX_SINGLE_TRACK_FALLBACKS) break;
      if (!selected.includes(item)) selected.push(item);
    }
  }
  return [...multi,...selected].map(({adapter,candidate})=>({adapter,candidate}));
}
