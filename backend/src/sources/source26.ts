/**
 * Source 26: direct mobile API -> signed CDN media, no embed pages.
 * Protocol informed by MovieBox-TUI (MIT OR Apache-2.0):
 * https://github.com/mesamirh/MovieBox-Tui/tree/b901738b56170c278b35468c32ade32b9de1890d/src/providers/moviebox
 * This implementation is independent and keeps sessions in RAM only.
 */
import crypto from 'node:crypto';
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import { readBoundedText } from './upstream-fetch.js';
import type { RawSourceResult, RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const ORIGIN = 'https://api6.aoneroom.com';
const PREFIX = '/wefeed-mobile-bff';
const UA = 'com.community.oneroom/50020120 (Linux; U; Android 12; en_US; 2201117TY; Build/S1B.220414.015; Cronet/135.0.7012.3)';
const KEY = Buffer.from('efa891974eecd3148df63aa611602defd101259ba521022c57ae0566bd8e', 'hex');
const CERT = '03d4b741632d136bc23e2de4c6adcdb7712f1980b619c183221801730bbd0410';
const REFERER = 'https://sportslive.wine';
const empty = (): RawSourceResult => ({ candidates: [] });
const obj = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const md5 = (value: string) => crypto.createHash('md5').update(value).digest('hex');

/** Canonical signing matches the mobile API, with decoded, sorted query pairs. */
export function movieBoxHeaders(method: string, url: string, body?: string, token?: string, now = Date.now()): Record<string, string> {
  const parsed = new URL(url);
  const pairs = [...parsed.searchParams.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const query = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, 'application/json', 'application/json', body === undefined ? '' : String(Buffer.byteLength(body)), String(now), body === undefined ? '' : md5(body), parsed.pathname + (query ? `?${query}` : '')].join('\n');
  const sig = crypto.createHmac('md5', KEY).update(canonical).digest('base64');
  const stamp = `${now}000${crypto.randomInt(1000)}`;
  const build = `${stamp}.${md5(`${CERT}oneroom${stamp}`)}`;
  const info = JSON.stringify({ package_name: 'com.community.oneroom', version_name: '4.0.01.0813.03', version_code: 50020120, os: 'android', os_version: '12', install_ch: 'ps', device_id: 'f8d8a26b993341d38a724c0014df4f91', install_store: 'ps', gaid: 'e5295979-8db3-4f56-82c1-66e5e5499841', brand: 'Redmi', model: '2201117TY', system_language: 'en', net: 'NETWORK_WIFI', region: 'US', timezone: 'Europe/London', sp_code: '40401', 'X-Play-Mode': '2', 'X-Client-Build': build });
  return { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json', 'x-client-token': `${now},${md5(String(now).split('').reverse().join(''))}`, 'x-tr-signature': `${now}|2|${sig}`, 'x-client-build': build, 'x-client-info': info, 'x-client-status': '0', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function normalTitle(s: string): string { return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function notice(url: string): boolean { return /1c7de0bd3393702d9191801f15f88f8d|9a0461bc39da389663bf3dbb17091d3f|b164fbfb4347792950bdfbfb563d39d9|\/notice\.mp4|macdn\.aoneroom\.com\/other\//i.test(url); }
function mediaType(url: string): 'dash' | 'hls' | 'mp4' | null {
  if (!isSafeUpstreamUrl(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  if (/\.mpd$/i.test(parsed.pathname)) return 'dash';
  if (/\.m3u8$/i.test(parsed.pathname)) return 'hls';
  if (/\.mp4$/i.test(parsed.pathname)) return 'mp4';
  return null;
}

/** Decode CDN policies only for DASH. HLS prefixes aren't known playable. */
export function movieBoxDashFromCookie(cookie: string): string | null {
  if (cookie.length > 16000 || /[\r\n]/.test(cookie)) return null;
  for (const part of cookie.split(';')) {
    const p = part.trim();
    try {
      let resource = '';
      if (p.includes('urlprefix=')) resource = Buffer.from(p.split('urlprefix=')[1].split(':')[0], 'base64url').toString('utf8');
      else if (p.startsWith('CloudFront-Policy=')) {
        const encoded = p.slice('CloudFront-Policy='.length).replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/');
        resource = String(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')).Statement?.[0]?.Resource ?? '');
      }
      const base = resource.replace(/\*+$/, '').replace(/\/+$/, '');
      if (base.includes('/dash/') && mediaType(`${base}/index.mpd`) === 'dash') return `${base}/index.mpd`;
    } catch { /* invalid policy */ }
  }
  return null;
}

function searchRows(data: Record<string, any>): Record<string, any>[] {
  const result = Array.isArray(data.results) ? data.results.flatMap((group: any) => Array.isArray(group?.subjects) ? group.subjects : []) : [];
  return [...result, ...(Array.isArray(data.list) ? data.list : [])].map(obj);
}
function chooseSubject(data: Record<string, any>, query: SourceQuery, title: string, year?: string): string | null {
  const wanted = normalTitle(title);
  if (!wanted) return null;
  const matches = searchRows(data).filter(row => {
    const type = Number(row.subjectType ?? row.stype);
    if (type !== (query.type === 'movie' ? 1 : 2)) return false;
    const rowTitle = String(row.title ?? row.name ?? '');
    const normalized = normalTitle(rowTitle);
    // Some catalogs split season one into a separate subject (e.g. 'Show S1').
    // Do not guess later seasons or language-labelled variants.
    if (normalized !== wanted && !(query.type === 'tv' && query.season === 1 && normalized === `${wanted} s1`)) return false;
    const rowYear = String(row.releaseDate ?? row.year ?? row.releaseInfo ?? '').match(/\b(?:19|20)\d{2}\b/)?.[0];
    return !year || !rowYear || rowYear === year;
  });
  const ids = [...new Set(matches.map(row => typeof row.subjectId === 'string' ? row.subjectId : typeof row.id === 'string' ? row.id : '').filter(id => /^\d+$/.test(id)))];
  return ids.length === 1 ? ids[0] : null;
}

export function createSource26Adapter(enabled: () => boolean = () => process.env.ELFURA_MOVIEBOX_ENABLED !== '0'): SourceAdapter {
  let session: { token: string; expires: number } | null = null;
  let loginPromise: Promise<string | null> | null = null;
  let cooldownUntil = 0;
  const device = crypto.randomBytes(16).toString('hex');

  async function request(path: string, method: 'GET' | 'POST', body: string | undefined, token: string | undefined, signal: AbortSignal): Promise<Record<string, any> | null> {
    if (Date.now() < cooldownUntil || signal.aborted) return null;
    const url = `${ORIGIN}${PREFIX}${path}`;
    const headers = movieBoxHeaders(method, url, body, token);
    // Keep a stable per-process installation identity without writing it to disk.
    const info = JSON.parse(headers['x-client-info']); info.device_id = device; headers['x-client-info'] = JSON.stringify(info);
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), signal, redirect: 'error' });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after'));
      cooldownUntil = Date.now() + (Number.isFinite(retry) && retry > 0 ? Math.min(retry, 300) * 1000 : 60_000);
      await res.body?.cancel();
      return null;
    }
    if (res.status === 401 || res.status === 403) { session = null; await res.body?.cancel(); return null; }
    if (!res.ok) { await res.body?.cancel(); return null; }
    const text = await readBoundedText(res, 1024 * 1024);
    if (!text) return null;
    const parsed = obj(JSON.parse(text));
    if (parsed.code !== undefined && Number(parsed.code) !== 0) return null;
    return obj(parsed.data ?? parsed);
  }
  async function login(): Promise<string | null> {
    if (session && session.expires > Date.now()) return session.token;
    if (!loginPromise) {
      loginPromise = (async () => {
        try {
          const result = await request('/user-api/visitor-login', 'POST', '{}', undefined, AbortSignal.timeout(8000));
          const token = typeof result?.token === 'string' ? result.token : '';
          if (!token || /[\r\n]/.test(token)) return null;
          let expires = Date.now() + 24 * 3600_000;
          try { const exp = Number(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp); if (exp > 0) expires = Math.min(expires, exp * 1000 - 60_000); } catch { /* non-JWT */ }
          if (expires <= Date.now()) return null;
          session = { token, expires }; return token;
        } catch { return null; }
      })().finally(() => { loginPromise = null; });
    }
    return loginPromise;
  }
  return {
    id: 'source-26', label: 'Source 26', enabled,
    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      if (!enabled() || Date.now() < cooldownUntil) return empty();
      const start = Date.now();
      const diag = (ok: boolean, detail: string) => query.diag?.push({ adapter: 'source-26', lane: 'direct', ok, ms: Date.now() - start, detail });
      const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000);
      try {
        const [meta, token] = await Promise.all([query.title ? Promise.resolve({ title: query.title, year: query.year }) : query.resolveMetaFallback?.(), login()]);
        const title = meta && ('rawTitle' in meta && meta.rawTitle || meta.title);
        if (!title || !token || signal.aborted) { diag(false, 'metadata-or-session-unavailable'); return empty(); }
        const search = await request('/subject-api/search/v2', 'POST', JSON.stringify({ keyword: title, page: 1, perPage: 15, subjectType: 0 }), token, signal);
        const subject = search && chooseSubject(search, query, title, meta?.year);
        if (!subject) {
          diag(false, `no-unambiguous-title-match rows=${search ? searchRows(search).length : 0}`);
          return empty();
        }
        const params = new URLSearchParams({ subjectId: subject });
        const season = query.type === 'tv' ? query.season : 0;
        const episode = query.type === 'tv' ? query.episode : 0;
        if (query.type === 'tv') {
          if (!Number.isInteger(season) || !Number.isInteger(episode) || !season || !episode || season < 1 || episode < 1) { diag(false, 'invalid-episode'); return empty(); }
          params.set('se', String(season)); params.set('ep', String(episode));
        }
        const resourceParams = new URLSearchParams({ subjectId: subject, page: '1', perPage: '20', all: '0', startPosition: '1', endPosition: '1', pagerMode: '2', resolution: '0', se: String(season), epFrom: String(episode), epTo: String(episode), isVip: 'true' });
        const [play, resources, details] = await Promise.all([
          request(`/subject-api/play-info/v2?${params}`, 'GET', undefined, token, signal).catch(() => null),
          request(`/subject-api/resource/v2?${resourceParams}`, 'GET', undefined, token, signal).catch(() => null),
          request(`/subject-api/get?${new URLSearchParams({ subjectId: subject })}`, 'GET', undefined, token, signal).catch(() => null),
        ]);
        const candidates: RawStreamCandidate[] = [];
        const seen = new Set<string>();
        const add = (url: string, cookie: string, quality: string, referer: boolean, claimedLang?: string) => {
          if (notice(url) || !mediaType(url) || seen.has(url) || /[\r\n]/.test(cookie) || cookie.length > 16000) return;
          seen.add(url);
          candidates.push({ key: url, url, type: mediaType(url)!, quality, rank: 10, ...(mediaType(url) === 'mp4' ? { probeMp4Audio: true } : {}), ...(claimedLang ? { claimedAudioLang: claimedLang } : {}), headers: { 'User-Agent': UA, ...(referer ? { Referer: REFERER } : {}), ...(cookie ? { Cookie: cookie } : {}) } });
        };
        for (const raw of Array.isArray(play?.streams) ? play.streams : []) {
          const stream = obj(raw); const cookie = typeof stream.signCookie === 'string' ? stream.signCookie.trim().replace(/;\s*$/, '') : '';
          const url = movieBoxDashFromCookie(cookie) ?? (typeof stream.url === 'string' ? stream.url : '');
          add(url, cookie, 'auto', true);
        }
        // Resource detectors can contain additional direct renditions that are
        // absent from play-info. Never fabricate resolutions from API metadata.
        const detailSubject = obj(details?.subject ?? details);
        for (const detector of (Array.isArray(detailSubject.resourceDetectors) ? detailSubject.resourceDetectors : []).slice(0, 8)) {
          const d = obj(detector);
          const rows = Array.isArray(d.resolutionList) && d.resolutionList.length
            ? d.resolutionList : query.type === 'movie' && typeof d.downloadUrl === 'string'
              ? [{ resourceLink: d.downloadUrl, se: 0, ep: 0 }] : [];
          for (const entry of rows.slice(0, 20)) {
            const r = obj(entry);
            if (Number(r.se ?? 0) !== season || Number(r.ep ?? 0) !== episode) continue;
            const url = typeof r.resourceLink === 'string' ? r.resourceLink : typeof r.url === 'string' ? r.url : '';
            const quality = /^\d{3,4}$/.test(String(r.resolution ?? '')) ? `${r.resolution}p` : 'auto';
            add(url, '', quality, false);
          }
        }
        // MovieBox represents dubs as linked subjects, not tracks in one MPD.
        // Resolve a bounded number concurrently, then let the existing manifest
        // verifier establish audioLang. API labels alone are only claims.
        const dubs = (Array.isArray(detailSubject.dubs) ? detailSubject.dubs : [])
          .map(obj).filter((dub: Record<string, any>) => dub.original !== true && typeof dub.subjectId === 'string' && /^\d+$/.test(dub.subjectId) && dub.subjectId !== subject)
          .slice(0, 24);
        let released = false;
        const resolveDub = async (dub: Record<string, any>) => {
          const dubParams = new URLSearchParams(params); dubParams.set('subjectId', dub.subjectId);
          const payload = await request(`/subject-api/play-info/v2?${dubParams}`, 'GET', undefined, token, signal).catch(() => null);
          const lang = normalizeLang(typeof dub.lanCode === 'string' ? dub.lanCode : '').code;
          for (const raw of Array.isArray(payload?.streams) ? payload.streams.slice(0, 8) : []) {
            const stream = obj(raw);
            const cookie = typeof stream.signCookie === 'string' ? stream.signCookie.trim().replace(/;\s*$/, '') : '';
            const url = movieBoxDashFromCookie(cookie) ?? (typeof stream.url === 'string' ? stream.url : '');
            add(url, cookie, 'auto', true, lang === 'und' ? undefined : lang);
          }
          if (released && query.onLateResult) query.onLateResult({ candidates: [...candidates] });
        };
        // Limit upstream pressure while checking all linked variants in batches.
        let dubCursor = 0;
        const allDubs = Promise.all(Array.from({ length: Math.min(4, dubs.length) }, async () => {
          while (dubCursor < dubs.length && !signal.aborted) await resolveDub(dubs[dubCursor++]);
        }));
        for (const raw of Array.isArray(resources?.list) ? [...resources.list].slice(0, 20).sort((a, b) => Number(obj(b).resolution ?? 0) - Number(obj(a).resolution ?? 0)) : []) {
          const row = obj(raw);
          if (Number(row.se ?? 0) !== season || Number(row.ep ?? 0) !== episode) continue;
          const url = typeof row.resourceLink === 'string' ? row.resourceLink : typeof row.url === 'string' ? row.url : '';
          const quality = /^\d{3,4}$/.test(String(row.resolution ?? '')) ? `${row.resolution}p` : 'auto';
          if (!notice(url)) { add(url, '', quality, false); continue; }
          // The API sometimes replaces downloads with a notice clip. Recover only
          // the exact resource and episode, never the notice itself.
          const id = typeof row.resourceId === 'string' ? row.resourceId : typeof row.id === 'string' ? row.id : '';
          if (!/^\d+$/.test(id) || signal.aborted) continue;
          const position = new URLSearchParams({ subjectId: subject, resourceId: id, failUrl: url, failCode: '404', resourceNum: '0', isVip: 'true' });
          const recovered = await request(`/subject-api/resource-position/v2?${position}`, 'GET', undefined, token, AbortSignal.any([signal, AbortSignal.timeout(1500)])).catch(() => null);
          for (const item of Array.isArray(recovered?.list) ? recovered.list.slice(0, 20) : []) {
            const r = obj(item);
            if (String(r.resourceId ?? r.id ?? '') !== id || Number(r.se ?? 0) !== season || Number(r.ep ?? 0) !== episode) continue;
            add(typeof r.resourceLink === 'string' ? r.resourceLink : typeof r.url === 'string' ? r.url : '', '', quality, false);
          }
          break; // At most one recovery attempt per resolution.
        }
        // Don't let one slow language stall startup; late results warm the
        // adapter cache for subsequent requests. A snapshot avoids mutation.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finished = await Promise.race([allDubs.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 2200); })]);
        if (timer) clearTimeout(timer);
        released = true;
        if (!finished && query.onLateResult) void allDubs.then(() => query.onLateResult?.({ candidates: [...candidates] }));
        diag(candidates.length > 0, candidates.length ? `candidates=${candidates.length}` : 'no-supported-media');
        return { candidates: [...candidates] };
      } catch (error) { diag(false, `request-failed:${(error as Error).name}`); return empty(); }
    },
  };
}
