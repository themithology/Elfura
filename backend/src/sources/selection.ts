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
/**
 * How many stream options one response may list.
 *
 * This is a presentation ceiling, not a safety valve: every lane here has been
 * either verified alive or left unproven rather than disproven, and the player
 * picks from the top. Raising it costs a few KB of JSON and gives the viewer
 * more chances of finding one that plays, which is the whole point — a source
 * dropped here is one they never get to try.
 */
export const MAX_LISTED_SOURCES = 200;
export const MAX_SINGLE_TRACK_FALLBACKS = MAX_LISTED_SOURCES;
export const MAX_SEPARATE_DUBS = 24;

/** Keep manifest-proven multilingual streams, diverse generic fallbacks, and
 * separately labelled language streams (not claimed as multi-audio).
 * A manifest/child check is evidence of reachability, not proof of full playback. */
export function selectPlaybackCandidates(
  entries: CandidateEntry[],
  preferredLang?: string,
  /**
   * Optional correctness tier per URL, lower is better.
   *
   * Exists because "alive" only says the bytes arrived, not that they are the
   * right video. A lane whose runtime this request measured and matched must
   * outrank one whose runtime could not be measured at all — otherwise a
   * 2-minute trailer that answered fast beats the episode, and the winner is
   * decided by network jitter. Before this, a probe that timed out under load
   * put an unmeasured clip in the same tier as a verified episode, and the
   * latency tiebreak then picked whichever had the shorter RTT that second.
   */
  rankHint?: (url: string) => number,
): CandidateEntry[] {
  const unique = new Set<string>();
  const multi: CandidateEntry[] = [];
  const single: (CandidateEntry & { alive: boolean; latency: number; host: string; order: number; tier: number })[] = [];
  for (const entry of entries) {
    const c = entry.candidate;
    if (unique.has(c.url)) continue;
    unique.add(c.url);
    // One helper answers "what do we know about this lane", preferring what
    // this request measured over what an earlier one remembered. With payload
    // caching off nothing is remembered, and ranking must still work.
    const evidence = candidateEvidence(c);
    if (evidence?.confirmedDead) continue;
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
      alive:!!evidence?.alive,latency:evidence?.rttMs ?? c.latencyMs ?? Number.POSITIVE_INFINITY,host,order:single.length,
      tier:rankHint ? rankHint(c.url) : 0});
  }
  const preferred = preferredLang ? normalizeLang(preferredLang).code : 'und';
  /**
   * Does this lane carry the language the viewer asked for?
   *
   * The measured/verified `audioLang` wins. Failing that, a provider label that
   * names exactly one language is still usable *for ordering* — a citadel row
   * says "Hindi" and the manifest confirms a single audio rendition, and that
   * pair is the whole reason the lane exists. It is deliberately NOT promoted to
   * `audioLang` in the response: ordering may use a label, presentation may not
   * claim one.
   */
  const languageOf = (item: typeof single[number]): string => {
    const verified = item.candidate.audioLang ?? item.candidate.measuredThisRequest?.audioLang;
    if (verified) return verified;
    return item.candidate.claimedAudioLang ?? 'und';
  };
  const matches = (item: typeof single[number]) => {
    if (preferred === 'und') return false;
    const lang = languageOf(item);
    return !!lang && lang.split('-')[0] === preferred.split('-')[0];
  };

  /**
   * How big is this stream, in bytes? Measured beats declared, and an unmeasured
   * stream is not zero — it is unknown, and unknown must never outrank known.
   *
   * The owner's rule: when several streams carry the requested language, the
   * largest one wins, because the largest one is the highest-quality copy. That
   * is why `measuredBytes` is a whole-runtime figure scaled from a real segment
   * rather than the provider's `BANDWIDTH=` claim: two mirrors of the same film
   * at the same label routinely differ by 2x in actual size, and the label is
   * exactly what the old board trusted.
   */
  const sizeOf = (item: typeof single[number]): number => {
    const measured = item.candidate.measuredBytes;
    if (typeof measured === 'number' && Number.isFinite(measured) && measured > 0) return measured;
    const bitrate = item.candidate.declaredBitrateBps;
    const runtime = item.candidate.measuredThisRequest?.durationSec ?? item.candidate.expectedRuntimeSec;
    if (typeof bitrate === 'number' && bitrate > 0 && typeof runtime === 'number' && runtime > 0) {
      // bits/s * seconds / 8 = bytes. A declaration, used only as a tiebreak
      // beneath any real measurement.
      return (bitrate * runtime) / 8;
    }
    return 0;
  };

  const variantOrder: ('sub' | 'dub')[] = preferred.split('-')[0] === 'en' ? ['dub', 'sub'] : ['sub', 'dub'];
  // The order the owner asked for, in one line:
  //   1. alive before unverified (never open on a stream we could not reach)
  //   2. the requested language before anything else
  //   3. the right runtime before the wrong one
  //   4. the biggest stream before the smaller one (highest quality)
  //   5. latency, then discovery order
  //
  // Runtime sits above size on purpose. A 70-minute file where the episode is 47
  // minutes is not a higher-quality copy of anything — it is the wrong content,
  // and it measures "bigger" only because it is wrong. Ranking it first would let
  // the size rule reward exactly the failure it is supposed to avoid.
  single.sort((a,b)=>
    Number(b.alive)-Number(a.alive) ||
    Number(matches(b))-Number(matches(a)) ||
    a.tier-b.tier ||
    sizeOf(b)-sizeOf(a) ||
    a.latency-b.latency ||
    a.order-b.order);
  const ordinarySingle = single.filter(item => !item.candidate.audioVariant);
  const ordered: typeof single = [];
  const orderedSet = new Set<typeof single[number]>();
  const hosts = new Set<string>();
  // A verified candidate always beats an unknown one. Within each confidence
  // class, independent hosts come first — but nothing is thrown away for being
  // on a host that already answered: max coverage, ordered by confidence.
  for (const alive of [true, false]) {
    const tier = ordinarySingle.filter(item => item.alive === alive);
    // The requested language keeps its priority inside each confidence class:
    // host variety may decide between rows of equal standing, but it must never
    // push a 6 GB English copy above the Hindi the viewer asked for.
    for (const wanted of [true, false]) {
      const group = tier.filter(item => matches(item) === wanted);
      for (const item of group) {
        if (hosts.has(item.host)) continue;
        ordered.push(item); orderedSet.add(item); hosts.add(item.host);
      }
      for (const item of group) {
        if (!orderedSet.has(item)) { ordered.push(item); orderedSet.add(item); }
      }
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
  // Variant-labelled streams are separate lanes, not manufactured manifest
  // audio. Preserve all sources' verified and unproven variants, not just one
  // sub/dub pair across the whole board. Never reinstate confirmed-dead lanes.
  const animeVariants: typeof single = [];
  for (const alive of [true, false]) for (const variant of variantOrder) {
    for (const item of single) {
      if (item.alive !== alive || item.candidate.audioVariant !== variant) continue;
      if (animeVariants.length >= MAX_LISTED_SOURCES) break;
      animeVariants.push(item);
    }
  }
  return [...multi,...selected,...animeVariants].map(({adapter,candidate})=>({adapter,candidate}));
}
