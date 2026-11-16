/**
 * Vidora lane — TMDB-keyed HLS player API (Source 20)
 * ===================================================
 * A public player endpoint that takes the TMDB id (plus season/episode for
 * series) and returns a direct adaptive HLS master with optional subtitle
 * tracks:
 *
 *   GET /movie/<tmdbId>
 *   GET /tv/<tmdbId>/<season>/<episode>
 *     -> { result, sources: [ { url, tracks: [ { file, label } ] } ] }
 *
 * The endpoint answers only with its public player key, so every request stays
 * server-side; the browser only ever receives `/api/v1/stream?t=...` tickets.
 * No scraping, no browser, no disk: one JSON request plus the shared liveness
 * probe on the returned manifest.
 */
import { isSafeUpstreamUrl } from '../security.js';
import { candidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import { normalizeLang } from './lang.js';
import { classifyUpstreamUrl, RELAY_RANK_PENALTY } from './provenance.js';
import type { RawStreamCandidate, RawTrackRef, SourceAdapter, SourceQuery } from './types.js';

const API = 'https://moviesapi.to/api/vidora/v1';
const PLAYER_REFERER = 'https://moviesapi.to/';
const PLAYER_KEY = '3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const MAX_JSON_BYTES = 256 * 1024;

async function readBounded(response: Response, maxBytes: number): Promise<Buffer | null> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function subtitleTracks(row: unknown): RawTrackRef[] {
  if (!row || typeof row !== 'object') return [];
  const tracks = (row as { tracks?: unknown }).tracks;
  if (!Array.isArray(tracks)) return [];
  const out: RawTrackRef[] = [];
  const seen = new Set<string>();
  for (const track of tracks.slice(0, 12)) {
    if (!track || typeof track !== 'object') continue;
    const entry = track as { file?: unknown; label?: unknown; lang?: unknown };
    const url = typeof entry.file === 'string' ? entry.file.trim() : '';
    if (!url || seen.has(url) || !isSafeUpstreamUrl(url)) continue;
    if (!/\.(?:vtt|srt|ass)(?:[?#]|$)/i.test(url)) continue;
    const rawLabel = typeof entry.label === 'string' ? entry.label.trim() : '';
    const normalized = normalizeLang(typeof entry.lang === 'string' ? entry.lang : rawLabel);
    if (normalized.code === 'und' && !rawLabel) continue;
    seen.add(url);
    out.push({
      lang: normalized.code !== 'und' ? normalized.code : 'und',
      label: normalized.code !== 'und' ? normalized.label : rawLabel,
      url,
      format: /\.srt/i.test(url) ? 'srt' : /\.ass/i.test(url) ? 'ass' : 'vtt',
    });
  }
  return out;
}

/** Build candidates from a Vidora payload. */
export function vidoraCandidates(body: unknown): RawStreamCandidate[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const sources = (body as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return [];
  const out: RawStreamCandidate[] = [];
  const seen = new Set<string>();
  for (const row of sources.slice(0, 4)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const url = (row as { url?: unknown }).url;
    if (typeof url !== 'string' || !url) continue;
    if (!/\.m3u8(?:[?#]|$)/i.test(url) || !isSafeUpstreamUrl(url) || seen.has(url)) continue;
    seen.add(url);
    const subtitles = subtitleTracks(row);
    out.push({
      key: url,
      url,
      type: 'hls',
      quality: 'auto',
      headers: { 'User-Agent': UA, Referer: PLAYER_REFERER },
      // A direct CDN master always outranks the provider's own worker relay.
      rank: 50 + out.length + (classifyUpstreamUrl(url) === 'relay' ? RELAY_RANK_PENALTY : 0),
      ...(subtitles.length ? { subtitles } : {}),
    });
  }
  return out;
}

export async function fetchFromVidora(query: SourceQuery): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId) || !['movie', 'tv'].includes(query.type)) return [];
  const season = query.season ?? 1;
  const episode = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 1 || !Number.isSafeInteger(episode) || episode < 1)) {
    return [];
  }
  const path =
    query.type === 'tv'
      ? `${API}/tv/${query.tmdbId}/${season}/${episode}`
      : `${API}/movie/${query.tmdbId}`;
  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(4000)])
    : AbortSignal.timeout(4000);
  try {
    const response = await fetch(path, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'x-player-key': PLAYER_KEY,
        Referer: PLAYER_REFERER,
        Origin: PLAYER_REFERER.slice(0, -1),
      },
      redirect: 'error',
      signal,
    });
    const buffer = await readBounded(response, MAX_JSON_BYTES);
    if (!buffer) return [];
    return vidoraCandidates(JSON.parse(buffer.toString('utf8')) as unknown);
  } catch {
    return [];
  }
}

export function createSource20Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-20',
    label: 'Source 20',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const raw = await fetchFromVidora(query);
      const checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      const usable = checked.candidates.filter((candidate) => !!candidateEvidence(candidate)?.alive);
      query.diag?.push({
        adapter: 'source-20',
        lane: 'V',
        ok: usable.length > 0,
        ms: Date.now() - started,
        detail: `candidates=${raw.length},reachable=${usable.length}`,
      });
      return {
        candidates: usable.map((candidate) =>
          query.diag ? { ...candidate, diagnosticLane: 'V' } : candidate,
        ),
      };
    },
  };
}
