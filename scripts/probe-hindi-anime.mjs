#!/usr/bin/env node
/**
 * Do the two Hindi-dub anime extractors from AniHype actually give Hindi?
 *
 * Both are AniList-keyed, so this asks by AniList id the same way the site does.
 * Nothing here is committed as a source: it is a measurement first, because
 * "Hindi dub" in a plugin comment is a claim, not evidence.
 *
 *   Mikaza   - /embed/haiku/ani/<id>/<ep>/hin  -> page carries `resolve:"<url>"`
 *              -> that URL returns JSON whose `source.resolvedLanguage` says
 *              which language the file really is. The plugin rejects ja/en.
 *   Orion    - /embed/anilist/<id>/<ep> -> `var embedMeta = {...}` inside the
 *              page -> orionStreams[] = one HLS per language.
 *
 * AniList ids: Naruto 20, One Piece 21, JJK 113415, AoT 16498, DBZ 223.
 */
const ANIME = [
  { label: 'Naruto', anilist: 20, ep: 1 },
  { label: 'One Piece', anilist: 21, ep: 1 },
  { label: 'JJK', anilist: 113415, ep: 1 },
  { label: 'AoT', anilist: 16498, ep: 1 },
  { label: 'DBZ', anilist: 223, ep: 1 },
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MIKAZA = 'https://mikaza.buzz';
const VIDRIFT = 'https://embed.vidrift.net';
const BASE = 'https://anihype.sbs';

const get = async (url, headers = {}) => {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text().catch(() => '');
  return { status: res.status, body, url: res.url };
};
const abs = (u, base) => {
  try {
    return new URL(String(u).replace(/\\\//g, '/').replace(/\\u0026/g, '&'), base).href;
  } catch {
    return '';
  }
};

async function probeMikaza(anime) {
  const embed = `${MIKAZA}/embed/haiku/ani/${anime.anilist}/${anime.ep}/hin`;
  const page = await get(embed, { Accept: 'text/html,*/*', Referer: BASE + '/' });
  if (page.status !== 200) return { status: page.status, note: `embed http=${page.status}`, langs: [] };

  const resolve = (page.body.match(/resolve\s*:\s*"([^"]+)"/) || [])[1];
  if (!resolve) return { status: 200, note: 'no resolve url in page', langs: [] };

  const json = await get(abs(resolve, MIKAZA), { Accept: 'application/json', Referer: embed });
  let payload;
  try {
    payload = JSON.parse(json.body);
  } catch {
    return { status: json.status, note: 'resolve returned non-JSON', langs: [] };
  }
  const declared = payload?.source?.resolvedLanguage ?? 'unknown';
  const src = payload?.src ? abs(payload.src, MIKAZA) : '';
  return {
    status: json.status,
    note: `resolvedLanguage=${declared} src=${src ? 'yes' : 'no'}`,
    langs: [String(declared)],
    playable: !!src,
  };
}

async function probeOrion(anime) {
  const embed = `${VIDRIFT}/embed/anilist/${anime.anilist}/${anime.ep}`;
  const page = await get(embed, { Accept: 'text/html,*/*', Referer: BASE + '/' });
  if (page.status !== 200) return { status: page.status, note: `embed http=${page.status}`, langs: [] };

  const mm = page.body.match(
    /var\s+embedMeta\s*=\s*(\{[\s\S]*?\});\s*(?:\n|<\/script>|var\s|const\s|let\s|window\.)/,
  );
  if (!mm) return { status: 200, note: 'no embedMeta', langs: [] };
  let meta;
  try {
    meta = JSON.parse(mm[1]);
  } catch {
    return { status: 200, note: 'embedMeta unparseable', langs: [] };
  }
  const streams = Array.isArray(meta.orionStreams) ? meta.orionStreams : [];
  const langs = streams.map((s) => String(s?.name || '?').replace(/^Orion\s*[·\-:]\s*/i, '').trim());
  return {
    status: 200,
    note: `orionStreams=${streams.length}${streams.length ? '' : ' (page cache miss?)'}`,
    langs,
    playable: streams.some((s) => s?.url),
  };
}

const tally = { mikaza: new Map(), orion: new Map() };
console.log('[hindi] title        mikaza                                    orion');
for (const anime of ANIME) {
  let m;
  let o;
  try {
    m = await probeMikaza(anime);
  } catch (e) {
    m = { note: 'error: ' + String(e?.message ?? e).slice(0, 40), langs: [] };
  }
  try {
    o = await probeOrion(anime);
  } catch (e) {
    o = { note: 'error: ' + String(e?.message ?? e).slice(0, 40), langs: [] };
  }
  for (const l of m.langs) tally.mikaza.set(l, (tally.mikaza.get(l) ?? 0) + 1);
  for (const l of o.langs) tally.orion.set(l, (tally.orion.get(l) ?? 0) + 1);
  console.log(
    `[hindi] ${anime.label.padEnd(11)}  ${String(m.note).padEnd(40)}  ${String(o.note).slice(0, 40)}`,
  );
  if (o.langs.length) console.log(`[hindi]   orion langs: ${o.langs.join(', ')}`);
}

console.log('');
for (const [lane, map] of Object.entries(tally)) {
  if (!map.size) {
    console.log(`[hindi] ${lane}: no language reported at all`);
    continue;
  }
  const ordered = [...map.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`[hindi] ${lane} languages: ${ordered.map(([l, n]) => `${l}×${n}`).join(', ')}`);
  const hindi = ordered.filter(([l]) => /hindi|^hin$|\bhin\b/i.test(l)).reduce((n, [, c]) => n + c, 0);
  console.log(`[hindi] ${lane} HINDI rows: ${hindi}`);
}
