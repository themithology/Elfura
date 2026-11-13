import { normalizeLang } from './lang.js';
import { cachedCandidateEvidence } from './liveness.js';
import type { RawStreamCandidate, SourceAdapter } from './types.js';

export interface CandidateEntry { adapter: SourceAdapter; candidate: RawStreamCandidate }
export const MAX_SINGLE_TRACK_FALLBACKS = 2;
export const MAX_SEPARATE_DUBS = 12;

/** Keep manifest-proven multilingual streams, diverse generic fallbacks, and
 * separately labelled language streams (not claimed as multi-audio).
 * A manifest/child check is evidence of reachability, not proof of full playback. */
export function selectPlaybackCandidates(entries: CandidateEntry[], preferredLang?: string): CandidateEntry[] {
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
  const preferred = preferredLang ? normalizeLang(preferredLang).code : 'und';
  const matches = (item: typeof single[number]) => preferred !== 'und' &&
    !!item.candidate.audioLang && item.candidate.audioLang.split('-')[0] === preferred.split('-')[0];
  single.sort((a,b)=>Number(b.alive)-Number(a.alive)||Number(matches(b))-Number(matches(a))||a.latency-b.latency||a.order-b.order);
  const ordinarySingle = single;
  const selected: typeof single = [];
  const hosts = new Set<string>();
  // A verified candidate always beats an unknown one. Within each confidence
  // class, prefer independent hosts before taking a second from one host.
  for (const alive of [true, false]) {
    const tier = ordinarySingle.filter(item => item.alive === alive);
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
  // Preserve individually labelled dubs like the older working build. They
  // remain separate streams, never synthetic tracks in a multi-audio manifest.
  const languages = new Set(selected.map(item => normalizeLang(item.candidate.audioLang || 'und').code).filter(lang => lang !== 'und'));
  let dubsAdded = 0;
  for (const item of ordinarySingle) {
    if (!item.alive || selected.includes(item)) continue;
    const lang = normalizeLang(item.candidate.audioLang || 'und').code;
    if (lang === 'und' || languages.has(lang)) continue;
    selected.push(item); languages.add(lang);
    if (++dubsAdded >= MAX_SEPARATE_DUBS) break;
  }
  return [...multi,...selected].map(({adapter,candidate})=>({adapter,candidate}));
}
