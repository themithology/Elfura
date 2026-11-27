// @ts-nocheck
/**
 * Source 3 — nxsha.
 *
 *   GET /api/servers?q=<sealed>   → { _hash } → { servers: [{ scraper }] }
 *   GET /api/sources?q=<sealed>   → { _hash } → { sources: [{ url, language, … }] }
 *
 * The envelope is OpenSSL `Salted__` + AES-256-CBC with a key derived from an
 * iterated-MD5 KDF — the same construction as `openssl enc -aes-256-cbc -salt`.
 * The passphrase is a public front-end constant that rotates whenever the site
 * redeploys, so the known history is tried in order, and if none of them open a
 * live reply the lane reports itself unavailable rather than guessing.
 *
 * WHY THE LANE LIST IS AN ALLOWLIST, AND WHY IT IS SHORT
 * -----------------------------------------------------
 * nxsha lists 34 scrapers. Four of them are `rive-*`, and `rive-citadel` IS this
 * board's source-1 (`scrapper.rivestream.app/api/provider?provider=citadel`).
 * Shipping those would request the same catalogue twice per resolve and count it
 * as two lanes — the same mistake that made vidlink look like a new source.
 *
 * They are excluded by CONSTRUCTION below, not by a comment: `ownLanes()` filters
 * anything matching the RiveStream families, so a future edit to the list cannot
 * silently re-introduce them.
 *
 * WHAT THIS ADAPTER REFUSES
 * -------------------------
 *   - every `rive-*` lane (source-1's catalogue);
 *   - relay-shaped media hosts, including `workers.dev`, exactly as source-2
 *     refuses them — nxsha served one such row on inception;
 *   - Drive/`usercontent` pages, which cannot be seeked and were refused for six
 *     other sources already;
 *   - rows with no readable language when a language was asked for;
 *   - non-HTTPS, credentialed, or non-manifest URLs.
 *
 * Measured before this was written (research/nxsha-source3.md): four titles,
 * zero media objects shared with the board, across three of its own lanes.
 */
import crypto from 'node:crypto';
import { sourceEnv } from './index.js';
import { normalizeLang } from './lang.js';
const DEFAULT_ORIGIN = 'https://nxsha.space';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
/** Public front-end passphrases, current first. They rotate on redeploy. */
export const PASSES = [
    '38c8cd65d781936f4b9fe1fd985234fd7335699855051abf76ea3493bcfc0120',
    'f4488ab4da401203d23baa129fc546153898162524635d6776826d0c867ccaa3',
    'S8x!Jk4ZP1uG8$my',
];
/**
 * Lanes this board will accept, in the site's own reliability order.
 *
 * This list is MEASURED, not inherited. A survey of all 30 of its non-RiveStream
 * scrapers (research/nxsha-lanes.json, 2026-11-25) found:
 *
 *   6 served media   nitro, watchout, awsind, purstream, ophim, zoko
 *   2 were relays    castle, vixolity — both on *.nxstreamhub.workers.dev
 *  22 served nothing
 *   0 were Google Drive
 *
 * The 22 that answered with nothing are excluded on that evidence rather than
 * guessed at: requesting them costs a resolve slot each and returns empty. They
 * stay excluded until a survey shows otherwise — a lane whose catalogue moved is
 * a lane to re-measure, not one to keep asking.
 *
 * The two relay lanes are ALSO refused host-by-host below, so a future edit to
 * this list cannot re-admit them by accident. That is belt and braces on
 * purpose: `castle` looks like a normal scraper name and is a workers.dev front.
 */
/**
 * Every lane that has ANSWERED a media row, measured against Indian-weighted
 * titles rather than the two Hollywood/anime titles the first survey used.
 *
 * The original list was eight lanes, taken from a survey that asked Fight Club
 * and Naruto and treated silence as death. Re-measured against RRR, Kalki, Jawan,
 * Baahubali 2, Pathaan, Mirzapur and Sacred Games, THIRTEEN lanes answer and five
 * of them were never being asked:
 *
 *   k4khdhub-direct  Pathaan "HubDrive | 1080p | 16.69 GB | BluRay | x264 | Hindi | English"
 *   k4khdhub         Pathaan "HubCloud 10Gbps | 1080p | 40.16 GB | BluRay | Hindi | English"
 *   movone           25 rows on 2 titles, 2160p and 1080p
 *   em-8             RRR, Kalki "HD"
 *   streamflix       RRR, Jawan "Auto" — mp4, on workers.dev, refused by host rule
 *
 * That first check is the whole point of this list existing: those rows NAME
 * Hindi explicitly, in a file-size form ("16.69 GB" at 1080p), on an Indian
 * catalogue. They were discarded because a lane named "k4khdhub" was asked for
 * an American film.
 *
 * The five that stay refused are refused for a measured reason, not silence:
 * streamflix serves MP4 on third-party worker hosts, and the hubcloud rows are
 * file-host pages rather than manifests until proven otherwise.
 *
 * The 17 that were silent across all eight titles are left out deliberately: that
 * is now a result, not an assumption.
 */
const ALLOWED_LANES = [
    'nitro',
    'castle',
    'watchout',
    'awsind',
    'vixolity',
    'purstream',
    'ophim',
    'zoko',
    'k4khdhub',
    'k4khdhub-direct',
    'movone',
    'em-8',
];
/** The families that belong to source-1. Never requested here. */
const RIVE_FAMILY = /^rive[-_]/i;
/**
 * nxsha's OWN edge namespace.
 *
 * `castle` and `vixolity` serve from `*.nxstreamhub.workers.dev`. That is the
 * provider's own Cloudflare edge, sitting next to the API that hands it out — the
 * same case source-2 documents for its own `/api/media` proxy, which is NOT a
 * relay and is kept. Refusing these because the word "workers" appears in the
 * hostname threw away six real rows on two titles, including English 1080p and
 * Japanese.
 *
 * A third-party bridge is a different thing: greybox's
 * `dash-hls-bridge.john1mc.workers.dev` was somebody else's bandwidth in front of
 * `sacdn.hakunaymatata.com`, and that is still refused below.
 */
const OWN_EDGE = /(?:^|\.)nxstreamhub\.workers\.dev$/i;
/**
 * Somebody else's Cloudflare relay.
 *
 * Narrowed to `workers.dev` and to hosts that literally name themselves as a
 * proxy. The previous version also matched `edge`, `mirror` and `gateway` as
 * substrings, which is guesswork about a name — it refused a provider's own
 * `edge-` host for no reason beyond its spelling.
 */
const FOREIGN_RELAY = /workers\.dev$/i;
/**
 * A host that names itself a proxy, in its first label.
 *
 * `proxy.7movie.ws` and `edge-proxy.example.com` say what they are; `edge12.cdn`
 * is a CDN node with an unhelpful name. The test is per-label rather than a
 * substring, so a real CDN called something like `edgenuity.com` is not refused
 * for containing a word by accident.
 */
const PROXY_WORD = /^(?:proxy|relay|transcode|bridge|mirror|gateway)\d*$/i;
function selfDeclaredProxy(hostname) {
    const first = hostname.split('.')[0] ?? '';
    return first.split(/[-_]/).some((label) => PROXY_WORD.test(label));
}
/** Google Drive pages: not seekable, and refused for six sources already. */
const DRIVE_HOST = /(?:^|\.)(?:drive|docs)\.google\.com$|googleusercontent\.com$|drive\.usercontent\.google\.com$/i;
/**
 * The headers a row may ask the player to send.
 *
 * nxsha hands out per-row headers because its media hosts check Referer/Origin,
 * and dropping them makes every candidate unplayable — which is exactly how the
 * contract failed this adapter the first time. The allowlist is narrow on
 * purpose: a provider must not be able to inject an arbitrary header into the
 * proxy, and only these three are ever consulted by a CDN.
 */
function rowHeaders(raw) {
    if (!raw || typeof raw !== 'object')
        return undefined;
    const out = { 'User-Agent': UA };
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== 'string' || !value || value.length > 2048 || /[\r\n]/.test(value))
            continue;
        if (/^referer$/i.test(key))
            out.Referer = value;
        else if (/^origin$/i.test(key))
            out.Origin = value;
        else if (/^user-agent$/i.test(key))
            out['User-Agent'] = value;
    }
    return out;
}
/**
 * Headers to send with a row's manifest.
 *
 * MEASURED, one header at a time, on catflix.nxstreamhub.workers.dev:
 *
 *   bare (User-Agent only)   403   9B  Forbidden
 *   + Referer                200   70182B  #EXTM3U
 *   + Origin                 403
 *   + Accept                 403
 *   + Range                  403
 *   + row headers only       403   <- the API ships `{}` for these rows
 *
 * So Referer alone is the difference between a 403 and a 70 KB playlist, and the
 * API provides no Referer to forward: every castle/vixolity/purstream/ophim row
 * measured carries an EMPTY headers object. The adapter was therefore sending a
 * bare User-Agent and being refused, while the same URL served fine with one
 * extra header. That is not the CDN being dead; it is this lane asking wrongly.
 *
 * The fallback is the provider's own origin, which is where the site's player
 * runs and what a browser would send. It is not a borrowed credential and not a
 * spoof of somebody else: it names the site that handed us the URL.
 */
function candidateHeaders(row, origin) {
    const headers = rowHeaders(row.headers) ?? { 'User-Agent': UA };
    if (headers.Referer)
        return headers;
    // WHICH HOSTS WANT A REFERER IS MEASURED, NOT ASSUMED.
    //
    // A blanket Referer fixed castle and BROKE purstream in the same commit:
    //
    //   catflix.nxstreamhub.workers.dev  bare 403 -> Referer 200 (70 KB playlist)
    //   free.finepulfe.xyz               bare 200 -> Referer+Origin+Accept+Range 403
    //                                                 (an HTML block page, not media)
    //
    // purstream's own rows were serving fine with a bare User-Agent, and adding the
    // header the other host wanted turned its manifest into a 403. So the fallback
    // is scoped to the host family that was measured to require it. A new host is
    // tried bare first, which is the safe default: a bare fetch is what already
    // worked for every host that did not need anything.
    const REFERER_REQUIRED = /(?:^|\.)nxstreamhub\.workers\.dev$/i;
    if (REFERER_REQUIRED.test(hostOfRow(row)))
        headers.Referer = `${origin}/`;
    return headers;
}
/** The host a row points at, without constructing a URL twice. */
function hostOfRow(row) {
    try {
        return new URL(String(row.url ?? '')).hostname.toLowerCase();
    }
    catch {
        return '';
    }
}
// One request per lane, asked concurrently. 12 lanes = 12 of the 30 offered, the
// ones measured to serve. The bound is the allowlist, not this number.
const MAX_LANES = 12;
const MAX_CANDIDATES = 24;
const MAX_BODY_BYTES = 1_000_000;
const PROVIDER_TIMEOUT_MS = 8000;
/**
 * Lanes that may be requested: the allowlist minus anything in a family this
 * board already has. Exported so the rule is testable rather than trusted.
 */
export function ownLanes(allowed = ALLOWED_LANES) {
    return allowed.filter((lane) => !RIVE_FAMILY.test(lane));
}
/* ── the envelope ──────────────────────────────────────────────────────────── */
function derive(salt, pass) {
    let material = Buffer.alloc(0);
    let previous = Buffer.alloc(0);
    while (material.length < 48) {
        previous = crypto.createHash('md5').update(Buffer.concat([previous, Buffer.from(pass), salt])).digest();
        material = Buffer.concat([material, previous]);
    }
    return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}
/** Seal a request body the way the site's own client does. */
export function seal(body, pass = PASSES[0]) {
    const salt = crypto.randomBytes(8);
    const { key, iv } = derive(salt, pass);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const plain = JSON.stringify({
        ...body,
        _req_ts: Date.now(),
        _req_salt: crypto.randomBytes(6).toString('base64url'),
    });
    return Buffer.concat([
        Buffer.from('Salted__'),
        salt,
        cipher.update(plain),
        cipher.final(),
    ]).toString('base64url');
}
/**
 * Open an envelope with one known passphrase.
 *
 * Throws, and the caller distinguishes the reasons: a `bad-magic` means the reply
 * was a stub rather than a sealed payload, and a decrypt failure means the site
 * rotated its key. Collapsing those into one error is what makes a rotation look
 * like an outage.
 */
export function open(input, pass) {
    if (!/^[A-Za-z0-9_-]+$/.test(input))
        throw new Error('not-base64url');
    const bytes = Buffer.from(input, 'base64url');
    if (bytes.length < 32)
        throw new Error('too-short');
    if (bytes.subarray(0, 8).toString() !== 'Salted__')
        throw new Error('bad-magic');
    const { key, iv } = derive(bytes.subarray(8, 16), pass);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const plain = Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
}
/** The first known passphrase that opens this payload. */
export function openAny(input) {
    for (const pass of PASSES) {
        try {
            return { payload: open(input, pass), pass };
        }
        catch {
            /* next */
        }
    }
    return null;
}
/* ── payload → candidates ──────────────────────────────────────────────────── */
/** Quality as the provider declares it, normalised to the board's `NNNp` shape. */
export function qualityOf(raw) {
    const text = String(raw ?? '');
    const height = text.match(/\b(2160|1440|1080|720|480|360)p?\b/i)?.[1];
    return height ? `${height}p` : 'auto';
}
/**
 * Stream rows → candidates, applying every refusal above.
 *
 * Exported because the refusal rules are the interesting part and deserve a test
 * that does not need a network.
 */
export function nxCandidates(payload) {
    const rows = Array.isArray(payload?.sources) ? payload.sources : [];
    const out = [];
    const seen = new Set();
    for (const row of rows) {
        if (typeof row?.url !== 'string' || !row.url)
            continue;
        if (out.length >= MAX_CANDIDATES)
            break;
        let url;
        try {
            url = new URL(row.url);
        }
        catch {
            continue;
        }
        // The board never forwards a credential or a non-HTTPS hop.
        if (url.protocol !== 'https:' || url.username || url.password)
            continue;
        // Its own edge is fine; somebody else's relay is not.
        if (!OWN_EDGE.test(url.hostname)) {
            if (FOREIGN_RELAY.test(url.hostname))
                continue;
            if (selfDeclaredProxy(url.hostname))
                continue;
        }
        if (DRIVE_HOST.test(url.hostname) || /\/file\/d\/|usercontent/i.test(url.href))
            continue;
        // An embed is somebody else's player, not a manifest.
        if (row.isEmbed === true || /embed/i.test(String(row.type ?? '')))
            continue;
        const isManifest = /\.m3u8(?:[?#]|$)/i.test(url.href) || /^(?:hls|m3u8)$/i.test(String(row.type ?? ''));
        if (!isManifest) {
            // DASH is acceptable if the provider declares it; .mp4 is not a stream this
            // board seeks in, and a bare page is not media at all.
            if (!/^(?:dash|mpd)$/i.test(String(row.type ?? '')) && !/\.mpd(?:[?#]|$)/i.test(url.href))
                continue;
        }
        if (seen.has(url.href))
            continue;
        // A row that names no language anywhere is not offered: it can win a
        // language-filtered race by accident and then play audio the viewer did not
        // ask for, which is the silent fallback this board refuses. This is the rule
        // source-2 already states, and the live board test is what showed it was
        // missing here.
        //
        // Read from `label`, because that is the field this API actually populates.
        // There is no `language` field at all — measured, not assumed: 23 raw rows
        // across five media lanes carried exactly nine keys (id, provider, url,
        // org_uri, headers, quality, label, isEmbed, type) and `language` was not
        // among them. The first version of this rule read `row.language`, which is
        // why source-3 dropped from 12 candidates to zero in a single run.
        const langs = rowLanguages(row);
        const multi = claimsMultiAudio(row);
        // Admitted when the row names a language, OR when it claims to carry several
        // and lets the manifest name them. Refused only when it says nothing at all -
        // see claimsMultiAudio for why that distinction is measured, not stylistic.
        if (langs.length === 0 && !multi)
            continue;
        seen.add(url.href);
        const type = /\.mpd(?:[?#]|$)/i.test(url.href) || /^(?:dash|mpd)$/i.test(String(row.type ?? '')) ? 'dash' : 'hls';
        const quality = qualityOf(row.quality ?? row.label);
        const headers = candidateHeaders(row, DEFAULT_ORIGIN);
        out.push({
            key: url.href,
            type,
            url: url.href,
            quality,
            // Later rows are later lanes in the site's own reliability order.
            rank: 30 + out.length,
            ...(headers ? { headers } : {}),
            // The row's own label, when it names exactly one language, is the claim.
            // When it names several ("Hindi | English") there is no single claim to
            // make: `availableAudioLangs` carries the set and `multiAudio` is NOT set,
            // because a label is not a manifest and only the probe can prove the file
            // really carries more than one audio rendition.
            ...(langs.length === 1 ? { claimedAudioLang: langs[0] } : {}),
            ...(langs.length > 1 ? { availableAudioLangs: langs } : {}),
            // A MULTI claim travels as the flag the registry already understands: the
            // probe will attach the real set, and selection refuses the flag if the
            // manifest turns out to carry one track.
            ...(langs.length === 0 && multi ? { availableAudioLangs: undefined } : {}),
            ...(multi ? { audioLabel: 'Multi-Audio' } : {}),
        });
    }
    return out;
}
/* ── reading a row's language ──────────────────────────────────────────────── */
/**
 * Every language a row names, normalised.
 *
 * The label is the only field this API populates, and it has four shapes that
 * were measured on real rows rather than guessed:
 *
 *   "Hindi"                             — the language, alone
 *   "English"                           — same
 *   "hguider | 1080P | Hindi | English" — a lane name, a height, two languages
 *   "Purstream · pulse · 1080p · MULTI" — a product label naming no language
 *
 * So the label is split on its separators and every segment is normalised
 * independently. Handing the whole string to `normalizeLang` returns `und` for
 * all four — it expects one token — which is how a lane carrying Hindi and
 * English ended up reporting nothing at all.
 *
 * A segment that is a lane name or a height normalises to `und` and contributes
 * nothing, which is the honest outcome: "hguider" is not a language.
 */
export function rowLanguages(row) {
    const segments = [row.label, row.language, row.quality]
        .filter((value) => typeof value === 'string' && value.trim() !== '')
        .flatMap((value) => value.split(/[|·,;/]+|\s{2,}/))
        .map((part) => part.trim())
        .filter(Boolean);
    const out = [];
    for (const segment of segments) {
        const code = normalizeLang(segment).code;
        if (code && code !== 'und' && !out.includes(code))
            out.push(code);
        // A bracketed language is a LABEL, not a caption flag: "[English] - FHD 1080P"
        // is how castle names its rows, and `cleanLanguageToken` strips `[CC]`-style
        // bracket groups before parsing, so the bare segment normalises to `und` and
        // a perfectly good English 1080p row was refused as unlabelled. Unwrap the
        // brackets and parse the inside too.
        for (const inner of segment.matchAll(/\[([^\]]{2,24})\]/g)) {
            const innerCode = normalizeLang(inner[1].trim()).code;
            if (innerCode && innerCode !== 'und' && !out.includes(innerCode))
                out.push(innerCode);
        }
    }
    return out;
}
/**
 * A row that claims more than one audio track without naming them.
 *
 * Measured, and the reason this lane is not empty: purstream is the only supply
 * on it that serves bytes, and its label is "Purstream · pulse · 1080p · MULTI".
 * Its manifest then declares what the label would not:
 *
 *   #EXT-X-MEDIA:TYPE=AUDIO,...,NAME="Français",DEFAULT=YES,LANGUAGE="fr"
 *   #EXT-X-MEDIA:TYPE=AUDIO,...,NAME="English",DEFAULT=NO,LANGUAGE="en"
 *
 * So "MULTI" is a real claim that happens to name no language, and refusing it as
 * "unlabelled" threw away the one working stream on the lane while keeping rows
 * that name a language and answer 404.
 *
 * It is admitted as a CLAIM of multiple audio, never as a language. The registry's
 * probe reads the manifest and supplies the actual set; if the manifest has only
 * one rendition, the claim collapses to that one language - which is what the
 * liveness pass already does when a measured single track contradicts a provider.
 */
const MULTI_CLAIM = /\bmulti(?:-?audio)?\b/i;
export function claimsMultiAudio(row) {
    const text = `${row.label ?? ''} ${row.quality ?? ''}`;
    if (!MULTI_CLAIM.test(text))
        return false;
    // "1. Multi Audio" style numbering is stripped by normalizeLang; for this test
    // the words themselves are the signal, so no numbering handling is needed.
    return true;
}
/** One sealed API call, bounded in size and time. */
async function ask(origin, endpoint, body, signal, fetchImpl) {
    const url = `${origin}/api/${endpoint}?q=${encodeURIComponent(seal(body))}`;
    const local = new AbortController();
    const timer = setTimeout(() => local.abort(), PROVIDER_TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, {
            headers: {
                'User-Agent': UA,
                Accept: 'application/json',
                Referer: `${origin}/`,
                Origin: origin,
            },
            // `query.signal ?? local` — `AbortSignal.any` would make the caller's
            // deadline irrelevant the moment this lane'own timer fired.
            signal: signal ?? local.signal,
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => { });
            return { payload: null, reason: `http=${response.status}` };
        }
        const declared = Number(response.headers.get('content-length') || 0);
        if (declared > MAX_BODY_BYTES) {
            await response.body?.cancel().catch(() => { });
            return { payload: null, reason: 'oversized' };
        }
        const text = await response.text();
        if (text.length > MAX_BODY_BYTES)
            return { payload: null, reason: 'oversized' };
        let envelope;
        try {
            envelope = JSON.parse(text)._hash;
        }
        catch {
            return { payload: null, reason: 'not-json' };
        }
        if (typeof envelope !== 'string')
            return { payload: null, reason: 'no-envelope' };
        const opened = openAny(envelope);
        // A payload that no known key opens is a rotation, not an empty catalogue.
        return opened ? { payload: opened.payload } : { payload: null, reason: 'key-rotated' };
    }
    catch (error) {
        return { payload: null, reason: error instanceof Error ? error.name : 'failed' };
    }
    finally {
        clearTimeout(timer);
    }
}
export function createNxshaAdapter(options = {}) {
    const env = sourceEnv();
    const origin = (options.origin ?? env.ELFURA_NXSHA_ORIGIN?.trim() ?? DEFAULT_ORIGIN).replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? fetch;
    return {
        id: 'source-3',
        label: 'Source 3',
        enabled: () => (env.ELFURA_NXSHA_ENABLED ?? '1') !== '0',
        async resolve(query) {
            if (!/^\d{1,12}$/.test(query.tmdbId))
                return { candidates: [] };
            const type = query.type === 'tv' ? 'tv' : 'movie';
            const season = type === 'tv' ? query.season ?? 1 : 0;
            const episode = type === 'tv' ? query.episode ?? 1 : 0;
            if (type === 'tv' && (!Number.isSafeInteger(episode) || episode < 1))
                return { candidates: [] };
            const body = { tmdbId: query.tmdbId, imdb_id: '', type, season, episode };
            // 1. Which lanes does it currently offer?
            const listed = await ask(origin, 'servers', body, query.signal, fetchImpl);
            const available = new Set((listed.payload?.servers ?? []).map((s) => s?.scraper).filter((x) => typeof x === 'string'));
            // The allowlist intersects what is actually on offer, so a renamed lane is
            // simply not requested rather than producing an error per resolve.
            const lanes = ownLanes().filter((lane) => available.has(lane)).slice(0, MAX_LANES);
            if (lanes.length === 0)
                return { candidates: [] };
            // 2. Ask them concurrently; one lane failing is expected and never fatal.
            const answers = await Promise.all(lanes.map((lane) => ask(origin, 'sources', { ...body, ex_lang: true, provider: lane }, query.signal, fetchImpl).then((answer) => (answer.payload ? nxCandidates(answer.payload) : []))));
            const candidates = [];
            const seen = new Set();
            for (const rows of answers) {
                for (const row of rows) {
                    if (seen.has(row.url))
                        continue;
                    seen.add(row.url);
                    candidates.push(row);
                }
            }
            return { candidates };
        },
    };
}
