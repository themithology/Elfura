import anivexaWorker from '../vendor/anivexa/index.js';
import { isSafeUpstreamUrl } from '../security.js';
import type { RawSourceResult, RawStreamCandidate, RawTrackRef, SourceAdapter, SourceQuery } from './types.js';

const INTERNAL_ORIGIN = 'https://anivexa.internal';
const MAX_PROVIDERS = 12;
const MAX_CANDIDATES = 24;

type AnivexaStream = {
  url?: unknown;
  file?: unknown;
  type?: unknown;
  format?: unknown;
  server?: unknown;
  quality?: unknown;
  priority?: unknown;
  referer?: unknown;
  headers?: unknown;
  subtitles?: unknown;
  embed?: unknown;
};

type AnivexaEpisode = { id?: unknown; number?: unknown };
type AnivexaProvider = { episodes?: { sub?: AnivexaEpisode[]; dub?: AnivexaEpisode[] } };

async function requestApi(path: string, signal: AbortSignal): Promise<unknown | null> {
  if (signal.aborted) return null;
  let onAbort: (() => void) | undefined;
  try {
    const request = new Request(new URL(path, INTERNAL_ORIGIN), {
      headers: { Accept: 'application/json' },
      signal,
    });
    // The bundled Worker can fan out to many provider fetches and does not
    // consistently propagate the incoming Request's abort signal downstream.
    // Race it explicitly so an unavailable provider cannot hold playback open.
    const responsePromise = anivexaWorker.fetch(request, { API_VERSION: '2.3' })
      .then(async response => response.ok ? await response.json() as unknown : null)
      .catch(() => null);
    const aborted = new Promise<null>(resolve => {
      onAbort = () => resolve(null);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return await Promise.race([responsePromise, aborted]);
  } catch {
    return null;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function streamType(stream: AnivexaStream, url: string): RawStreamCandidate['type'] | null {
  const declared = `${String(stream.type ?? '')} ${String(stream.format ?? '')}`.toLowerCase();
  if (/\.m3u8(?:[?#]|$)/i.test(url) || /\bhls\b|m3u8/.test(declared)) return 'hls';
  if (/\.mpd(?:[?#]|$)/i.test(url) || /\bdash\b|mpd/.test(declared)) return 'dash';
  if (/\.(?:mp4|m4v|webm)(?:[?#]|$)/i.test(url) || /\bmp4\b|progressive/.test(declared)) return 'mp4';
  return null;
}

function safeHeaders(stream: AnivexaStream, mediaUrl: URL): Record<string, string> {
  const raw = stream.headers && typeof stream.headers === 'object'
    ? stream.headers as Record<string, unknown>
    : {};
  const out: Record<string, string> = {};
  for (const name of ['Accept', 'Origin', 'Referer', 'User-Agent']) {
    const entry = Object.entries(raw).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (typeof entry === 'string' && entry.length <= 2048) out[name] = entry;
  }
  const referer = typeof stream.referer === 'string' ? stream.referer : '';
  if (referer && isSafeUpstreamUrl(referer)) out.Referer = referer;
  if (!out.Origin && out.Referer) {
    try { out.Origin = new URL(out.Referer).origin; } catch { /* use media origin */ }
  }
  if (!Object.keys(out).some((key) => key.toLowerCase() === 'user-agent')) {
    out['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
  }
  if (!out.Origin && !out.Referer) out.Origin = mediaUrl.origin;
  return out;
}

function subtitleTracks(value: unknown): RawTrackRef[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((item: any) => {
    const rawUrl = typeof item?.url === 'string' ? item.url : typeof item?.file === 'string' ? item.file : '';
    const label = String(item?.label ?? item?.title ?? '').trim().slice(0, 100);
    if (!rawUrl || !isSafeUpstreamUrl(rawUrl)) return [];
    const formatRaw = String(item?.format ?? new URL(rawUrl).pathname.split('.').pop() ?? '').toLowerCase();
    const format = formatRaw.includes('ass') ? 'ass' : formatRaw.includes('srt') ? 'srt' : 'vtt';
    const lang = String(item?.lang ?? item?.srclang ?? 'und').trim().slice(0, 24) || 'und';
    return [{ lang, label: label || lang, url: rawUrl, format, ...(item?.default ? { default: true } : {}) }];
  });
}

function collectStreams(payload: any): AnivexaStream[] {
  if (Array.isArray(payload?.streams)) return payload.streams.slice(0, 8);
  if (Array.isArray(payload?.sources)) return payload.sources.slice(0, 8);
  if (typeof payload?.url === 'string' || typeof payload?.file === 'string') return [payload];
  return [];
}

async function resolveAnivexa(query: SourceQuery, episodeDataOverride?: Record<string, AnivexaProvider>): Promise<RawSourceResult> {
  const empty: RawSourceResult = { candidates: [] };
  const anilistId = String(query.anilistId ?? '').trim();
  const episodeNumber = Number(query.anilistEpisode ?? query.episode);
  if (!/^\d{1,10}$/.test(anilistId) || Number(anilistId) < 1 || query.type !== 'tv' || !Number.isSafeInteger(episodeNumber) || episodeNumber < 1) {
    return empty;
  }

  const started = Date.now();
  // The generated Worker can outlive an aborted Request and its episode index
  // occasionally takes longer than the playback response budget. Keep that
  // work bounded, but detach it from the caller signal so a late index can warm
  // the adapter cache instead of being discarded.
  const signal = AbortSignal.timeout(30_000);
  let episodeData = episodeDataOverride;
  if (!episodeData) {
    const indexTask = requestApi(`/episodes/${anilistId}`, signal) as Promise<Record<string, AnivexaProvider> | null>;
    let indexTimer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol('episode-index-timeout');
    const result = await Promise.race([
      indexTask,
      new Promise<typeof timedOut>(resolve => { indexTimer = setTimeout(() => resolve(timedOut), 7_000); }),
    ]);
    if (indexTimer) clearTimeout(indexTimer);
    if (result === timedOut) {
      query.diag?.push({ adapter: 'source-16', lane: 'E', ok: false, ms: Date.now() - started, detail: 'episode-index=still-pending' });
      if (query.onLateResult) {
        void indexTask.then(async lateIndex => {
          if (!lateIndex) return;
          const lateResult = await resolveAnivexa({ ...query, signal: AbortSignal.timeout(30_000) }, lateIndex);
          query.onLateResult?.(lateResult);
        }).catch(() => {});
      }
      return empty;
    }
    episodeData = result ?? undefined;
  }
  if (!episodeData) {
    query.diag?.push({ adapter: 'source-16', lane: 'E', ok: false, ms: Date.now() - started, detail: 'episode-index=unavailable' });
    return empty;
  }

  const providerEntries = Object.entries(episodeData)
    .filter(([key, value]) => key !== 'mappings' && key !== 'page' && key !== 'type' && value && typeof value === 'object')
    .slice(0, MAX_PROVIDERS);
  const jobs = providerEntries.flatMap(([provider, result], providerIndex) =>
    (['sub', 'dub'] as const).flatMap((audio) => {
      const episode = result.episodes?.[audio]?.find((item) => Number(item.number) === episodeNumber);
      const episodePath = typeof episode?.id === 'string' ? episode.id.replace(/^\/+/, '') : '';
      return episodePath && /^watch\/[a-z0-9-]+\/\d+\/(?:sub|dub)\/[a-z0-9-]+-\d+$/i.test(episodePath)
        ? [{ provider, audio, episodePath, providerIndex }]
        : [];
    }),
  );
  query.diag?.push({ adapter: 'source-16', lane: 'E', ok: true, ms: Date.now() - started,
    detail: `episode-index=ok,providers=${providerEntries.length},watchJobs=${jobs.length}` });

  const candidates: RawStreamCandidate[] = [];
  const seen = new Set<string>();
  let completed = 0;
  let releaseEarly: (() => void) | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const early = new Promise<void>(resolve => { releaseEarly = resolve; });
  const addPayload = (provider: string, audio: 'sub' | 'dub', providerIndex: number, payload: Record<string, unknown> | null) => {
    if (!payload || candidates.length >= MAX_CANDIDATES) return;
    for (const [streamIndex, stream] of collectStreams(payload).entries()) {
      const rawUrl = typeof stream.url === 'string' ? stream.url : typeof stream.file === 'string' ? stream.file : '';
      if (!rawUrl || stream.embed === true || /\b(?:embed|iframe)\b/i.test(rawUrl) || !isSafeUpstreamUrl(rawUrl)) continue;
      const url = new URL(rawUrl);
      const type = streamType(stream, url.href);
      if (!type || seen.has(url.href)) continue;
      seen.add(url.href);
      const quality = String(stream.quality ?? 'auto').trim().slice(0, 24) || 'auto';
      const rankRaw = Number(stream.priority);
      candidates.push({
        key: `${provider}:${episodeNumber}:${audio}:${url.href}`,
        type,
        url: url.href,
        headers: safeHeaders(stream, url),
        quality,
        audioVariant: audio,
        audioLabel: audio === 'sub' ? 'Japanese SUB' : 'English DUB',
        subtitles: subtitleTracks(stream.subtitles),
        rank: Number.isFinite(rankRaw) ? Math.max(1, Math.min(999, Math.round(rankRaw))) : providerIndex * 16 + (audio === 'dub' ? 8 : 0) + streamIndex,
      });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    if (candidates.length && !graceTimer) {
      // Give SUB/DUB siblings a short chance to join, but don't wait for every
      // slow provider once at least one playable route is known.
      graceTimer = setTimeout(() => releaseEarly?.(), 180);
    }
  };

  const allWatchJobs = Promise.all(jobs.map(async job => {
    try {
      const payload = await requestApi(`/${job.episodePath}`, signal) as Record<string, unknown> | null;
      addPayload(job.provider, job.audio, job.providerIndex, payload);
    } finally {
      completed++;
      if (completed >= jobs.length) releaseEarly?.();
    }
  }));
  const remainingBudget = Math.max(0, 5_200 - (Date.now() - started));
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    allWatchJobs,
    early,
    new Promise<void>(resolve => { budgetTimer = setTimeout(resolve, remainingBudget); }),
  ]);
  if (graceTimer) clearTimeout(graceTimer);
  if (budgetTimer) clearTimeout(budgetTimer);

  const sortedCandidates = () => [...candidates].sort((a, b) => a.rank - b.rank).slice(0, MAX_CANDIDATES);
  const current = sortedCandidates();
  query.diag?.push({ adapter: 'source-16', lane: 'W', ok: current.length > 0, ms: Date.now() - started,
    detail: `watchJobs=${jobs.length},completed=${completed},candidates=${current.length}` });
  if (completed < jobs.length && query.onLateResult) {
    void allWatchJobs.then(() => query.onLateResult?.({ candidates: sortedCandidates() })).catch(() => {});
  }
  return { candidates: current };
}

export function createSource16Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-16',
    label: 'Anivexa',
    enabled,
    async resolve(query) {
      return resolveAnivexa(query);
    },
  };
}
