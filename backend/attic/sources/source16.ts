/**
 * Source 16 — the Hindi-dub anime lane (Mikaza).
 *
 * Replaces the retired Anivexa source, which needed installation credentials and
 * made zero requests without them. This one needs nothing configured.
 *
 * Measured 2026-11-16 from a GitHub runner against five AniList-keyed anime
 * (Naruto 20, One Piece 21, JJK 113415, AoT 16498, DBZ 223): **5/5** returned
 * `source.resolvedLanguage = "hin"` with a playable `src`. That field is the
 * provider's own statement of the language of the file, not our label and not
 * inferred from the title — which is why this lane can legitimately call itself
 * Hindi.
 *
 * Protocol (from AniHype's plugin, reimplemented here):
 *   GET  https://mikaza.buzz/embed/haiku/ani/<anilistId>/<ep>/hin
 *        -> the page carries `resolve:"<url>"`
 *   GET  <resolve>            (JSON)
 *        -> { src, source: { resolvedLanguage }, tracks[] }
 *
 * The lane is AniList-keyed, but the embed URL must stay simple, so the TMDB id
 * is converted server-side by ./anime-db.js. A viewer uses `/embed/tv/46260`
 * and never learns that an AniList id was involved.
 *
 * Not carried over from the reference: Orion (embed.vidrift.net). Its embed
 * returned 403 from a datacenter address on all five titles, and AniHype's own
 * comment says Cloudflare refuses that call from datacentre networks. Shipping a
 * lane we know is blocked would just add latency to every resolve.
 */
import { isSafeUpstreamUrl } from '../security.js';
import { candidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import { normalizeLang } from './lang.js';
import { anilistIdForTmdb } from './anime-db.js';
import type { RawSourceResult, RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const MIKAZA = 'https://mikaza.buzz';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** Raised from 8s in the reference: the resolve hop is a second provider call. */
const TIMEOUT_MS = 9_000;

interface MikazaRaw {
  src?: unknown;
  source?: { resolvedLanguage?: unknown };
  tracks?: Array<{ src?: unknown; url?: unknown; file?: unknown; label?: unknown; lang?: unknown; srclang?: unknown }>;
}

const asUrl = (value: unknown, base: string): string => {
  try {
    return new URL(String(value).replace(/\\\//g, '/').replace(/\\u0026/g, '&'), base).href;
  } catch {
    return '';
  }
};

/**
 * The provider states the language of the file it is about to hand over. Treat
 * that as the only acceptable proof: anything that is not Hindi is dropped, and
 * so is anything unstated.
 */
function declaredLang(payload: MikazaRaw): string | null {
  const raw = payload?.source?.resolvedLanguage;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const { code, label } = normalizeLang(raw.trim(), raw.trim());
  if (code === 'hi' || /hindi/i.test(label)) return 'hi';
  // `hin` is ISO 639-2 for Hindi and appears as-is in the payload.
  if (/^hin$/i.test(raw.trim())) return 'hi';
  return null;
}

async function getText(url: string, accept: string, referer: string, signal: AbortSignal): Promise<string | null> {
  if (!isSafeUpstreamUrl(url)) return null;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept, Referer: referer, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
    signal,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  return res.text();
}

export async function fetchFromMikaza(
  query: SourceQuery,
  options: { trace?: string[] } = {},
): Promise<RawStreamCandidate[]> {
  const trace = options.trace;
  // A TMDB show can span multiple AniList entries or use different episode
  // numbering. Reusing episode 1 for every TMDB season silently plays the
  // wrong episode. Until we have a verified TMDB-season mapping, only an
  // explicitly supplied AniList id AND episode can opt into later seasons.
  if (query.type === 'tv' && (query.season ?? 1) !== 1 &&
      !(query.anilistId && /^\d{1,10}$/.test(query.anilistId) && query.anilistEpisode != null)) {
    trace?.push('unmapped-season');
    return [];
  }
  const episode = query.anilistEpisode ?? query.episode ?? 1;
  if (!Number.isSafeInteger(episode) || episode < 1) {
    trace?.push('bad-episode');
    return [];
  }

  // Prefer an explicit AniList id, otherwise convert from TMDB over the network.
  let anilistId = query.anilistId && /^\d{1,10}$/.test(query.anilistId) ? query.anilistId : '';
  if (!anilistId) {
    const mapped = await anilistIdForTmdb(query.tmdbId).catch(() => null);
    if (!mapped) {
      trace?.push('no-anilist-mapping');
      return [];
    }
    anilistId = mapped.anilistId;
    trace?.push(`mapped=${anilistId}`);
  }

  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);

  const embed = `${MIKAZA}/embed/haiku/ani/${anilistId}/${episode}/hin`;
  let page: string | null;
  try {
    page = await getText(embed, 'text/html,application/xhtml+xml,*/*', MIKAZA + '/', signal);
  } catch {
    trace?.push('embed-unreachable');
    return [];
  }
  if (!page) {
    trace?.push('embed-refused');
    return [];
  }

  const resolve = (page.match(/resolve\s*:\s*"([^"]+)"/) || [])[1];
  if (!resolve) {
    trace?.push('no-resolve-in-page');
    return [];
  }
  const resolveUrl = asUrl(resolve, MIKAZA);
  if (!resolveUrl) {
    trace?.push('bad-resolve-url');
    return [];
  }

  let payload: MikazaRaw;
  try {
    const raw = await getText(resolveUrl, 'application/json', embed, signal);
    if (!raw) {
      trace?.push('resolve-refused');
      return [];
    }
    payload = JSON.parse(raw) as MikazaRaw;
  } catch {
    trace?.push('resolve-not-json');
    return [];
  }

  const lang = declaredLang(payload);
  if (!lang) {
    trace?.push(`lang=${String(payload?.source?.resolvedLanguage ?? 'unstated')}`);
    return [];
  }

  const src = typeof payload.src === 'string' ? asUrl(payload.src, MIKAZA) : '';
  if (!src || !isSafeUpstreamUrl(src)) {
    trace?.push('no-src');
    return [];
  }

  const subtitles = (payload.tracks ?? [])
    .map((track) => {
      const url = asUrl(track?.src ?? track?.url ?? track?.file, MIKAZA);
      if (!url || !isSafeUpstreamUrl(url)) return null;
      const label = String(track?.label ?? track?.lang ?? 'Subtitle').slice(0, 60);
      return { url, label, lang: String(track?.srclang ?? track?.lang ?? '').slice(0, 12) };
    })
    .filter((t): t is { url: string; label: string; lang: string } => !!t)
    .slice(0, 12);

  trace?.push('ok=1');
  return [
    {
      key: `mikaza:${anilistId}:${episode}`,
      // One file per episode, so the request itself identifies it.
      fingerprint: `mikaza:${anilistId}:${episode}`,
      latencyMs: 0,
      type: 'mp4',
      url: src,
      headers: {},
      quality: 'auto',
      audioLang: 'hi',
      audioLabel: 'Hindi',
      multiAudio: false,
      ...(subtitles.length ? { subtitles } : {}),
      rank: 24,
    } as RawStreamCandidate,
  ];
}

export function createSource16Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-16',
    label: 'Source 16',
    enabled,
    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      const started = Date.now();
      const trace: string[] = [];
      const raw = await fetchFromMikaza(query, { trace }).catch(() => []);
      const checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      const usable = checked.candidates.filter((candidate) => !!candidateEvidence(candidate)?.alive);
      query.diag?.push({
        adapter: 'source-16',
        lane: 'MKZ',
        ok: usable.length > 0,
        ms: Date.now() - started,
        detail: `candidates=${raw.length},alive=${usable.length}` +
          (trace.length ? ` ${[...new Set(trace)].slice(0, 4).join(' ')}` : ''),
      });
      return {
        candidates: usable.map((candidate) =>
          query.diag ? { ...candidate, diagnosticLane: 'MKZ' } : candidate,
        ),
      };
    },
  };
}
