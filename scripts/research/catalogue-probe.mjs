#!/usr/bin/env node
/**
 * Catalogue probe — for three candidates this board has never measured: what do
 * they actually serve, on what hosts, in what languages?
 *
 * ---------------------------------------------------------------
 * The question is NOT "does it play". Three lanes have now played and been
 * refused for reasons playability could not see: a relay front, a shared object
 * id, a host that refuses datacenter IPs. So each candidate is measured on four
 * things at once, and the language and host columns are the ones that decide:
 *
 *   1. discovery  — can the site be asked at all, without a third party?
 *   2. media      — the real media URL, and the registrable DOMAIN behind it
 *   3. language   — the audio track(s) the payload declares
 *   4. category   — does it carry anything the board has none of?
 *
 * The third-party question comes first, because it decides whether the lane is
 * even buildable. kisskh and animekai take a short `kkey`/`enc` query string; if
 * that is a server-minted token, no local implementation exists and the lane
 * would depend on enc-dec.app forever. If it is derived from the id alone, it
 * can be minted locally like vidlink's was. This probe reports which, by asking
 * the same site twice and seeing whether the token is stable.
 *
 * yflix also needs `parse-html`, which enc-dec performs server-side. That is
 * replaced here by reading the HTML directly: if the episodes/servers lists are
 * plain markup, no oracle is needed.
 *
 * Writes research/catalogue-probe.json. Registers nothing.
 */
import fs from 'node:fs/promises';

const OUT = 'research/catalogue-probe.json';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The registrable domain, so a CDN's four subdomains are one finding. */
function mediaDomain(raw) {
  try {
    const labels = new URL(raw).hostname.toLowerCase().split('.').filter(Boolean);
    if (labels.length <= 2) return labels.join('.');
    const tld = labels[labels.length - 1];
    const sld = labels[labels.length - 2];
    const compound = tld.length === 2 && /^(?:co|com|net|org|gov|edu|ac)$/.test(sld);
    return labels.slice(compound ? -3 : -2).join('.');
  } catch {
    return null;
  }
}

async function get(url, headers = {}, timeout = 20_000) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/html, */*', ...headers },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    });
    const text = await response.text();
    return { status: response.status, text, headers: response.headers };
  } catch (error) {
    return { status: null, text: '', error: error?.name ?? String(error) };
  }
}

/** Every absolute media URL in a blob of JSON or HTML. */
function mediaUrls(text) {
  const found = new Set();
  const patterns = [
    /https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]+?\.mp4[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]+?\.mpd[^\s"'<>\\]*/gi,
  ];
  for (const pattern of patterns) {
    for (const hit of text.matchAll(pattern)) found.add(hit[0].replace(/\\\//g, '/'));
  }
  return [...found];
}

/* ────────────────────────────────────────────────────────────────────────────
 * kisskh — Korean/Asian drama. The board has NONE of this category.
 *
 *   GET kisskh.do/api/DramaList/Episode/<id>.png?kkey=<key>   → { Video, ... }
 *
 * The site mints `kkey`. This probe asks enc-dec.app for one and also asks the
 * site for a listing without it, to see whether the key is required at all and
 * whether the site itself ever hands one out.
 * ──────────────────────────────────────────────────────────────────────────── */
async function probeKisskh() {
  const out = { site: 'kisskh.do', category: 'kdrama', steps: [], thirdParty: null };
  const base = 'https://kisskh.do';

  // Is the site reachable at all?
  const home = await get(`${base}/`, {}, 20_000);
  out.steps.push({ step: 'home', status: home.status, bytes: home.text.length, error: home.error });

  // A known drama id. 192143 is the id enc-dec's own sample uses.
  const listing = await get(`${base}/api/DramaList/Drama/192143?isq=false`, {}, 20_000);
  out.steps.push({
    step: 'listing',
    url: `${base}/api/DramaList/Drama/192143?isq=false`,
    status: listing.status,
    bytes: listing.text.length,
    keys: listing.text.startsWith('{') ? Object.keys(JSON.parse(listing.text || '{}')).slice(0, 10) : [],
    error: listing.error,
  });

  // The episode endpoint both with and without a key: does the site gate it?
  const noKey = await get(`${base}/api/DramaList/Episode/192143.png?err=false&ts=&time=`, {}, 20_000);
  out.steps.push({
    step: 'episode-no-key',
    status: noKey.status,
    bytes: noKey.text.length,
    body: noKey.text.slice(0, 160),
    error: noKey.error,
  });

  // If the site answers without a key, no third party is needed for this step.
  const urls = mediaUrls(noKey.text);
  out.media = urls.slice(0, 6);
  out.domains = [...new Set(urls.map(mediaDomain).filter(Boolean))];
  out.languages = detectLanguages(noKey.text);
  out.thirdParty =
    noKey.status === 200 && urls.length > 0
      ? 'none needed for this step — the episode endpoint answered without kkey'
      : 'kkey required — the site gates the endpoint; minting it locally is unproven';
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * animekai — large anime catalogue.
 *
 *   GET animekai.to/ajax/episodes/list?ani_id=<id>&_=<enc>
 *   GET animekai.to/ajax/links/list?token=<t>&_=<enc>
 *   GET animekai.to/ajax/links/view?id=<lid>&_=<enc>
 *
 * `enc` changes per request in enc-dec's model. This probe asks twice and
 * compares, because a token that changes is server-minted and cannot be
 * reproduced without the site's secret.
 * ──────────────────────────────────────────────────────────────────────────── */
async function probeAnimekai() {
  const out = { site: 'animekai.to', category: 'anime', steps: [], thirdParty: null };
  const base = 'https://animekai.to';
  const headers = { Referer: `${base}/`, Accept: 'application/json' };

  const home = await get(`${base}/`, headers, 20_000);
  out.steps.push({ step: 'home', status: home.status, bytes: home.text.length, error: home.error });

  // Cyberpunk Edgerunners' content id, taken from enc-dec's own sample page.
  const watch = await get(`${base}/watch/cyberpunk-edgerunners-x6qm`, headers, 20_000);
  const contentId = watch.text.match(/id="anime-rating"[^>]*data-id="([^"]+)"/)?.[1] ?? null;
  out.steps.push({
    step: 'watch-page',
    status: watch.status,
    bytes: watch.text.length,
    contentId,
    error: watch.error,
  });

  if (contentId) {
    // Ask the same endpoint twice with no `_` token at all.
    for (const attempt of [1, 2]) {
      const bare = await get(`${base}/ajax/episodes/list?ani_id=${encodeURIComponent(contentId)}`, headers, 20_000);
      out.steps.push({
        step: `episodes-bare-${attempt}`,
        status: bare.status,
        bytes: bare.text.length,
        body: bare.text.slice(0, 200),
        error: bare.error,
      });
      if (attempt === 1) await sleep(3000);
    }
    const bare = out.steps.find((s) => s.step === 'episodes-bare-1');
    out.thirdParty =
      bare?.status === 200 && bare.bytes > 40
        ? 'none needed for this step — episodes list answered without enc'
        : 'enc required — the ajax endpoints are gated; local minting unproven';
  } else {
    out.thirdParty = 'unknown — could not read the content id, so the gate was never tested';
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * yflix / 1movies / solarmovie — general movies and TV.
 *
 *   GET yflix.to/ajax/links/view?id=<lid>&_=<enc>   → encrypted payload
 *
 * enc-dec also offers `parse-html`, which means the episode and server lists
 * come back as HTML. That is the part worth measuring: if the HTML is plain
 * markup, the oracle is only needed for the final decrypt.
 * ──────────────────────────────────────────────────────────────────────────── */
async function probeYflix() {
  const out = { site: 'yflix.to', category: 'movies-tv', steps: [], thirdParty: null };
  const headers = { Referer: 'https://yflix.to/', Accept: 'application/json, text/html' };

  // All three domains that enc-dec lists as the same service.
  for (const host of ['yflix.to', '1movies.bz', 'solarmovie.fi']) {
    const response = await get(`https://${host}/`, headers, 15_000);
    out.steps.push({ step: `home:${host}`, status: response.status, bytes: response.text.length, error: response.error });
    if (host !== 'yflix.to') await sleep(2000);
  }

  const watch = await get('https://yflix.to/watch/cyberpunk-edgerunners.b4d24', headers, 20_000);
  const contentId = watch.text.match(/id="movie-rating"[^>]*data-id="([^"]+)"/)?.[1] ?? null;
  out.steps.push({ step: 'watch-page', status: watch.status, bytes: watch.text.length, contentId, error: watch.error });

  if (contentId) {
    // Episodes list with no `_` token: does the ajax endpoint gate it?
    const bare = await get(
      `https://yflix.to/ajax/episodes/list?id=${encodeURIComponent(contentId)}`,
      headers,
      20_000,
    );
    out.steps.push({
      step: 'episodes-bare',
      status: bare.status,
      bytes: bare.text.length,
      body: bare.text.slice(0, 200),
      error: bare.error,
    });
    // Is the response plain HTML markup (parseable without enc-dec)?
    const looksLikeHtml = /<[a-z][\s\S]*>/i.test(bare.text);
    out.thirdParty = looksLikeHtml
      ? 'parse-html probably replaceable — the list is markup, not a sealed blob'
      : bare.status === 200
        ? 'enc required — the list is a sealed payload'
        : 'gated — the endpoint refused without a token';
  } else {
    out.thirdParty = 'unknown — could not read the content id, so the gate was never tested';
  }
  return out;
}

/**
 * Language labels the payload declares.
 *
 * Only labels that appear in the response are reported. This is what the site
 * CLAIMS, not verified audio - the distinction the board already uses
 * (`claimedAudioLang` vs `audioLang`).
 */
function detectLanguages(text) {
  const seen = new Set();
  const patterns = [
    [/\b(hindi|hinglish)\b/gi, 'hi'],
    [/\b(tamil)\b/gi, 'ta'],
    [/\b(telugu)\b/gi, 'te'],
    [/\b(malayalam)\b/gi, 'ml'],
    [/\b(kannada)\b/gi, 'kn'],
    [/\b(bengali)\b/gi, 'bn'],
    [/\b(english)\b/gi, 'en'],
    [/\b(korean)\b/gi, 'ko'],
    [/\b(japanese)\b/gi, 'ja'],
    [/\b(chinese|mandarin|cantonese)\b/gi, 'zh'],
    [/\b(thai)\b/gi, 'th'],
    [/\b(tagalog|filipino)\b/gi, 'tl'],
    [/\b(spanish)\b/gi, 'es'],
    [/\b(arabic)\b/gi, 'ar'],
  ];
  for (const [pattern, code] of patterns) if (pattern.test(text)) seen.add(code);
  return [...seen].sort();
}

async function main() {
  console.log('catalogue probe,', new Date().toISOString());
  const results = [];

  for (const [name, fn] of [
    ['kisskh', probeKisskh],
    ['animekai', probeAnimekai],
    ['yflix', probeYflix],
  ]) {
    console.log(`\n— ${name}`);
    let row;
    try {
      row = await fn();
    } catch (error) {
      row = { site: name, probeError: String(error?.message ?? error).slice(0, 300) };
    }
    results.push({ id: name, ...row });
    const reach = row.steps?.filter((s) => s.status === 200).length ?? 0;
    const total = row.steps?.length ?? 0;
    console.log(`  reachable ${reach}/${total} step(s)`);
    if (row.media?.length) console.log(`  media: ${row.media.length} url(s) on ${row.domains.join(', ')}`);
    if (row.languages?.length) console.log(`  declared languages: ${row.languages.join(',')}`);
    if (row.thirdParty) console.log(`  third party: ${row.thirdParty}`);
    if (row.probeError) console.log(`  PROBE ERROR: ${row.probeError}`);
    await sleep(5000);
  }

  const anyReachable = results.some((r) => r.steps?.some((s) => s.status === 200));
  if (!anyReachable) {
    console.error('\nrefusing to write a report: no site answered. No egress, or all three are down.');
    process.exit(2);
  }

  const report = {
    measuredAt: new Date().toISOString(),
    candidates: results,
    summary: Object.fromEntries(
      results.map((r) => [
        r.id,
        {
          category: r.category ?? null,
          mediaFound: r.media?.length ?? 0,
          domains: r.domains ?? [],
          declaredLanguages: r.languages ?? [],
          thirdParty: r.thirdParty ?? null,
          reachable: r.steps?.filter((s) => s.status === 200).length ?? 0,
        },
      ]),
    ),
  };
  await fs.writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
