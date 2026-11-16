import { normalizeLang } from './lang.js';
import { candidateEvidence } from './liveness.js';
import type { RawStreamCandidate, SourceAdapter } from './types.js';

export interface CandidateEntry { adapter: SourceAdapter; candidate: RawStreamCandidate }
/**
 * Coverage first: every adapter that answered contributes its usable lanes, so
 * a title shows as many streams as the sources actually returned. Two is the
 * old value, and it silently hid whole sources: twenty adapters resolved, two
 * streams listed, and the player looked like it had lost most of them.
 * The cap exists only as a sanity bound on the response size.
 */
export const MAX_LISTED_SOURCES = 48;
export const MAX_SINGLE_TRACK_FALLBACKS = MAX_LISTED_SOURCES;
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
    // One helper answers "what do we know about this lane", preferring what
    // this request measured over what an earlier one remembered. With payload
    // caching off nothing is remembered, and ranking must still work.
    const evidence = candidateEvidence(c);
    // Manifest truth about the audio layout beats provider metadata: a measured
    // single-language probe means single-language, however the source labelled
    // itself. Only when nothing was measured may the provider claim stand.
    const measuredLangs = evidence?.alive ? evidence.discoveredAudioLangs : undefined;
    const providerLangs = c.availableAudioLangs ?? [];
    const langs = measuredLangs !== undefined
      ? [...new Set(measuredLangs)]
      : evidence?.alive
        ? []
        : [...new Set(providerLangs)];
    if (evidence?.alive && langs.length > 1) {
      multi.push({ adapter:entry.adapter, candidate:{...c,multiAudio:true,availableAudioLangs:langs,audioLang:undefined,audioLabel:undefined} });
      continue;
    }
    // Never promote upstream metadata, a timed-out probe, or multiple copies of
    // the same language into a supposedly multilingual source.
    let host = '';
    try { host = new URL(c.url).hostname.toLowerCase(); } catch { continue; }
    // A provider multi-audio flag that no measurement backs never survives into
    // the response: an unproven claim is what makes a language switch look
    // available while the audio never changes.
    single.push({adapter:entry.adapter,candidate:{...c,multiAudio:false,availableAudioLangs:langs.length===1?langs:undefined},
      alive:!!evidence?.alive,latency:evidence?.rttMs ?? c.latencyMs ?? Number.POSITIVE_INFINITY,host,order:single.length});
  }
  const preferred = preferredLang ? normalizeLang(preferredLang).code : 'und';
  const matches = (item: typeof single[number]) => preferred !== 'und' &&
    !!item.candidate.audioLang && item.candidate.audioLang.split('-')[0] === preferred.split('-')[0];
  const variantOrder: ('sub' | 'dub')[] = preferred.split('-')[0] === 'en' ? ['dub', 'sub'] : ['sub', 'dub'];
  single.sort((a,b)=>Number(b.alive)-Number(a.alive)||Number(matches(b))-Number(matches(a))||a.latency-b.latency||a.order-b.order);
  const ordinarySingle = single.filter(item => !item.candidate.audioVariant);
  const ordered: typeof single = [];
  const hosts = new Set<string>();
  // A verified candidate always beats an unknown one. Within each confidence
  // class, independent hosts come first — but nothing is thrown away for being
  // on a host that already answered: max coverage, ordered by confidence.
  for (const alive of [true, false]) {
    const tier = ordinarySingle.filter(item => item.alive === alive);
    for (const item of tier) {
      if (hosts.has(item.host)) continue;
      ordered.push(item); hosts.add(item.host);
    }
    for (const item of tier) {
      if (!ordered.includes(item)) ordered.push(item);
    }
  }
  const selected: typeof single = ordered.slice(0, MAX_LISTED_SOURCES);
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
  // Keep one verified live source for each Anivexa SUB/DUB mode even when the
  // generic unlabelled fallback cap would otherwise drop one side. These are
  // provider source variants, not claims about manifest audio tracks.
  const animeVariants: typeof single = [];
  for (const variant of variantOrder) {
    const item = single.find(candidate => candidate.alive && candidate.candidate.audioVariant === variant);
    if (item && !selected.includes(item)) animeVariants.push(item);
  }
  return [...multi,...selected,...animeVariants].map(({adapter,candidate})=>({adapter,candidate}));
}
