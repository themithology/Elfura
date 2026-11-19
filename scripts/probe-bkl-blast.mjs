#!/usr/bin/env node
/**
 * Is the Nxsha `bkl-blast` lane reliable, and what languages does it give?
 *
 * Runs on a GitHub runner because the sandbox that edits code has no egress.
 *
 * Reliability is measured as: how many titles the lane returns ANY stream for,
 * out of however many we ask. Language is read from each stream's own label -
 * the provider states it, we do not infer it from the title.
 *
 * It imports source5's real nxEncode / derive rather than copying them: a
 * reimplementation would drift the moment nxsha rotates the passphrase, and
 * then the probe would be measuring the probe.
 */
import crypto from 'node:crypto';

const { nxEncode, nxDecodeWith } = await import('../dist/backend/sources/source5.js');

// nxsha rotates its passphrase on redeploy; source5 exports the current set.
// Try each in order and keep whichever opens the reply.
const ORIGINS = [
  { origin: 'https://nxsha.space', pass: '38c8cd65d781936f4b9fe1fd985234fd7335699855051abf76ea3493bcfc0120' },
  { origin: 'https://web.nxsha.app', pass: 'S8x!Jk4ZP1uG8$my' },
];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// A spread: mainstream Hollywood, an Indian title, anime, an older film, and a
// long-running series. If the lane only works for one region, this shows it.
const TITLES = [
  { label: 'movie 550 (Fight Club)', type: 'movie', tmdbId: '550' },
  { label: 'movie 693134 (Dune 2)', type: 'movie', tmdbId: '693134' },
  { label: 'movie 155 (Dark Knight)', type: 'movie', tmdbId: '155' },
  { label: 'movie 872585 (Oppenheimer)', type: 'movie', tmdbId: '872585' },
  { label: 'movie 980489 (Gran Turismo)', type: 'movie', tmdbId: '980489' },
  { label: 'tv 1399 (GoT s1e1)', type: 'tv', tmdbId: '1399', season: 1, episode: 1 },
  { label: 'tv 1399 (GoT s2e5)', type: 'tv', tmdbId: '1399', season: 2, episode: 5 },
  { label: 'tv 94605 (Arcane s1e1)', type: 'tv', tmdbId: '94605', season: 1, episode: 1 },
];

const LANE = 'bkl-blast';

async function request(origin, pass, endpoint, query) {
  const q = nxEncode(query);
  const url = `${origin}/api/${endpoint}?q=${q}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: origin + '/', Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 80) };
  // The reply is a JSON envelope whose _hash field holds the OpenSSL payload.
  // Decoding the raw body instead was my first bug: it reported "invalid payload"
  // for every title and looked identical to a dead lane.
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, error: 'not-json: ' + text.slice(0, 40) };
  }
  if (typeof envelope?._hash !== 'string') {
    return { ok: false, status: res.status, error: 'no _hash envelope' };
  }
  try {
    return { ok: true, status: res.status, payload: nxDecodeWith(envelope._hash, pass) };
  } catch (error) {
    const bytes = Buffer.from(String(envelope._hash), 'base64url');
    const magic = bytes.subarray(0, 8).toString('latin1');
    const why = bytes.length < 32 ? 'bad-envelope' : magic !== 'Salted__' ? 'bad-magic' : 'no-key';
    return { ok: false, status: res.status, error: `decode ${why} ${bytes.length}b` };
  }
}

for (const { origin, pass } of ORIGINS) {
  console.log(`\n[probe] === ${origin}`);
  let responded = 0;
  const langs = new Map();
  const rows = [];

  for (const title of TITLES) {
    // Exactly the shape fetchFromNxsha builds (source5.ts ~line 173): the lane
    // travels as `provider`, season/episode are always present and 0 for films,
    // and ex_lang asks for the language-labelled rows. My first attempt sent
    // {type,id,scraper} and got an empty-but-valid reply for every lane.
    const isTv = title.type === 'tv';
    const query = {
      tmdbId: title.tmdbId,
      imdb_id: '',
      type: title.type,
      season: isTv ? title.season ?? 1 : 0,
      episode: isTv ? title.episode ?? 1 : 0,
      ex_lang: true,
      provider: LANE,
    };

    let outcome;
    try {
      outcome = await request(origin, pass, 'sources', query);
    } catch (error) {
      outcome = { ok: false, error: String(error?.message ?? error) };
    }

    const payload = outcome.ok ? outcome.payload : null;
    if (process.env.SHOW_KEYS && payload) {
      console.log(`[probe]   keys=${Object.keys(payload).join(',')} servers=${payload.servers?.length ?? '-'} sources=${payload.sources?.length ?? '-'}`);
    }
    const streams = Array.isArray(payload?.sources) ? payload.sources : [];
    const playable = streams.filter((s) => typeof s?.url === 'string' && /^https?:/.test(s.url));
    if (playable.length) responded += 1;

    for (const s of playable) {
      const label = String(s.label ?? s.language ?? 'unlabelled').trim();
      langs.set(label, (langs.get(label) ?? 0) + 1);
    }

    rows.push({
      title: title.label,
      n: playable.length,
      langs: [...new Set(playable.map((s) => String(s.label ?? s.language ?? '?')))].join(',') || '-',
      note: outcome.ok ? '' : `${outcome.status ?? ''} ${outcome.error ?? ''}`.trim().slice(0, 60),
    });
  }

  for (const r of rows) {
    console.log(`[probe] ${r.title.padEnd(26)} ${String(r.n).padStart(3)} streams  ${r.langs.padEnd(28)} ${r.note}`);
  }

  const rate = ((responded / TITLES.length) * 100).toFixed(0);
  console.log(`[probe] lane=${LANE} titles-with-results=${responded}/${TITLES.length} (${rate}%)`);
  if (langs.size) {
    const ordered = [...langs.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`[probe] languages: ${ordered.map(([l, n]) => `${l}×${n}`).join(', ')}`);
  } else {
    console.log('[probe] languages: none — the lane returned no playable stream');
  }
  void crypto;

  // Control: the same query shape against a lane the audit already showed
  // returning data. If this is also 0, the query shape is wrong and the
  // bkl-blast result above proves nothing.
  let control = 0;
  for (const title of TITLES) {
    const isTv = title.type === 'tv';
    const query = {
      tmdbId: title.tmdbId,
      imdb_id: '',
      type: title.type,
      season: isTv ? title.season ?? 1 : 0,
      episode: isTv ? title.episode ?? 1 : 0,
      ex_lang: true,
      provider: 'nitro',
    };
    try {
      const out = await request(origin, pass, 'sources', query);
      const n = out.ok ? (out.payload?.sources?.length ?? 0) : 0;
      if (n) control += 1;
    } catch { /* counted as no result */ }
  }
  console.log(`[probe] CONTROL lane=nitro titles-with-results=${control}/${TITLES.length}`);
  if (control === 0) console.log('[probe] CAUTION: the control lane returned nothing, so the query shape is wrong and the bkl-blast figure is not evidence.');

  if (responded > 0) break; // this origin + passphrase works; another pass proves nothing new
}
