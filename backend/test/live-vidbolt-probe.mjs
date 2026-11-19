/** Direct live Vidbolt discovery probe for Re:Zero S1E1 (CI/manual only).
 * Prints statuses, source counts, audio languages, and media-byte results only.
 * Never prints upstream URLs, signed query strings, response bodies, or headers.
 */
const TMDB_ID = '65942';
const SEASON = 1;
const EPISODE = 1;
const TITLE = 'Re:ZERO -Starting Life in Another World- S1E1';
const YEAR = '2016';
const VIDBOLT_ORIGIN = 'https://vidbolt.xyz';
const SCRAPER_ORIGIN = 'https://scraper.vidbolt.xyz';
const CURX_KEY = 'streamrip_secret_2026';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const baseHeaders = {
  Accept: 'application/json, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': UA,
  Referer: `${VIDBOLT_ORIGIN}/`,
  Origin: VIDBOLT_ORIGIN,
};

const query = new URLSearchParams({
  tmdbId: TMDB_ID,
  title: TITLE,
  year: YEAR,
  season: String(SEASON),
  episode: String(EPISODE),
});
const targets = [
  {
    id: 'orion-tv',
    url: `https://img.animecurx.tech/api/tv/${TMDB_ID}/${SEASON}/${EPISODE}?api_key=${CURX_KEY}&apikey=${CURX_KEY}`,
  },
  ...['Quasar', 'Saffron', 'Callisto', 'FastVa', 'Ninetta', 'Naija', 'Nova'].map((name) => ({
    id: name.toLowerCase(),
    url: `${SCRAPER_ORIGIN}/scrape/${name}/tv/tmdb${TMDB_ID}?${query}`,
  })),
];

function sourcesFrom(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  for (const key of ['sources', 'files', 'links']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  for (const key of ['data', 'result']) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = sourcesFrom(payload[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function normalizeSource(raw, targetId) {
  const url = String(raw?.url || raw?.link || raw?.file || raw?.src || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    targetId,
    url,
    headers: raw?.headers && typeof raw.headers === 'object' ? raw.headers : {},
    quality: String(raw?.quality || raw?.resolution || raw?.label || 'auto'),
    language: String(raw?.language || raw?.lang || raw?.audio || ''),
    type: String(raw?.type || ''),
  };
}

async function fetchWithTimeout(url, headers = baseHeaders, timeout = 15000) {
  return fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
}

async function readTextBounded(res, max = 2 * 1024 * 1024) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error('manifest exceeded size limit');
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchMedia(url, headers) {
  const res = await fetchWithTimeout(url, { ...headers, Accept: '*/*', Range: 'bytes=0-1023' });
  if (!(res.status === 200 || res.status === 206)) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`media HTTP ${res.status}`);
  }
  const ct = String(res.headers.get('content-type') || '').toLowerCase();
  if (/text\/html|application\/json|xml/.test(ct)) {
    await res.body?.cancel().catch(() => {});
    throw new Error('media returned an error document');
  }
  if (!res.body) throw new Error('empty media body');
  const reader = res.body.getReader();
  const first = await reader.read();
  await reader.cancel().catch(() => {});
  if (first.done || !first.value?.byteLength) throw new Error('empty media body');
  return first.value.byteLength;
}

function firstSegment(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXTINF\b/i.test(lines[i].trim())) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      if (!line.startsWith('#')) return line.replace(/\\([_/])/g, '$1');
      break;
    }
  }
  return '';
}

function firstVariant(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF\b/i.test(lines[i].trim())) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      if (!line.startsWith('#')) return line.replace(/\\([_/])/g, '$1');
      break;
    }
  }
  return '';
}

function audioTracks(text) {
  const tracks = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^#EXT-X-MEDIA:/i.test(line.trim()) || !/TYPE=AUDIO\b/i.test(line)) continue;
    const uri = line.match(/\bURI="([^"]+)"/i)?.[1]?.replace(/\\([_/])/g, '$1');
    if (!uri) continue;
    tracks.push({
      uri,
      language: line.match(/\bLANGUAGE="?([^",]+)"?/i)?.[1] || 'und',
      name: line.match(/\bNAME="([^"]+)"/i)?.[1] || 'Audio',
    });
  }
  return tracks;
}

async function fetchPlaylist(url, headers) {
  const res = await fetchWithTimeout(url, {
    ...headers,
    Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, application/dash+xml, */*;q=0.8',
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`manifest HTTP ${res.status}`);
  }
  const text = await readTextBounded(res);
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('invalid HLS manifest');
  return text;
}

async function probeHls(source, headers) {
  const master = await fetchPlaylist(source.url, headers);
  const tracks = audioTracks(master);
  const languages = [...new Set(tracks.map((t) => t.language || t.name))];
  const variant = firstVariant(master);
  const childRefs = [...new Set([variant, ...tracks.map((t) => t.uri)].filter(Boolean))];
  if (!childRefs.length) {
    const segment = firstSegment(master);
    if (!segment) throw new Error('HLS leaf has no media segment');
    await fetchMedia(new URL(segment, source.url).toString(), headers);
    return { languages, media: 'segment' };
  }
  for (const ref of childRefs) {
    const childUrl = new URL(ref, source.url).toString();
    const child = await fetchPlaylist(childUrl, headers);
    const segment = firstSegment(child);
    if (!segment) throw new Error('HLS child has no media segment');
    await fetchMedia(new URL(segment, childUrl).toString(), headers);
  }
  return { languages, media: `${childRefs.length} playlist(s)+segments` };
}

async function probeSource(source) {
  const headers = { ...baseHeaders, ...source.headers };
  const hls = /m3u8|mpegurl/i.test(source.type) || /\.m3u8(?:[?#]|$)/i.test(source.url);
  if (!hls) {
    await fetchMedia(source.url, headers);
    return { languages: source.language ? [source.language] : [], media: 'non-HLS bytes' };
  }
  return probeHls(source, headers);
}

let discovered = 0;
let playable = 0;
const report = [];
for (const target of targets) {
  let status = 0;
  try {
    const res = await fetchWithTimeout(target.url);
    status = res.status;
    const text = await readTextBounded(res);
    if (!res.ok) {
      console.log(`[resolve] ${target.id}: HTTP ${status}`);
      report.push({ id: target.id, status, sources: 0 });
      continue;
    }
    const payload = JSON.parse(text);
    const sources = sourcesFrom(payload)
      .map((raw) => normalizeSource(raw, target.id))
      .filter(Boolean);
    if (target.id === 'orion-tv' && !sources.length && payload?.m3u8_path) {
      const path = String(payload.m3u8_path).replace(/^\/+/, '');
      const generated = normalizeSource({
        url: `https://img.rousav.tech/${path}?api_key=${CURX_KEY}`,
        quality: '1080p',
        type: 'm3u8',
      }, target.id);
      if (generated) sources.push(generated);
    }
    discovered += sources.length;
    console.log(`[resolve] ${target.id}: HTTP ${status}, ${sources.length} source(s)`);
    report.push({ id: target.id, status, sources: sources.length });
    for (let i = 0; i < sources.length; i++) {
      try {
        const result = await probeSource(sources[i]);
        playable++;
        console.log(`[pass] ${target.id}:${i + 1} ${sources[i].quality}: ${result.media}; audio=[${result.languages.join(',')}]`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[fail] ${target.id}:${i + 1} ${sources[i].quality}: ${message}`);
      }
    }
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw.replace(/https?:\/\/\S+/g, '<url>');
    console.log(`[resolve] ${target.id}: ${status || 'request failed'} ${message}`);
    report.push({ id: target.id, status, sources: 0, error: message });
  }
}

console.log('[summary] ' + JSON.stringify({ title: 'Re:Zero S1E1', discovered, playable, report }));
if (!discovered || !playable) process.exitCode = 1;
