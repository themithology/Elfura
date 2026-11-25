#!/usr/bin/env node
/**
 * Re-test nxsha.s space on the endpoints it actually serves data from.
 *
 * ---------------------------------------------------------------
 * nxsha was rejected in this repo with "Cloudflare challenge — 0/8", and that
 * verdict came from one thing: `/watch/<type>/<id>` HTML pages answering 403.
 * That is the WEBSITE, not the API. The retired adapter never touched `/watch`:
 * it called
 *
 *   GET /api/servers?q=<sealed>     -> { _hash } -> AES-CBC -> { servers: [{scraper}] }
 *   GET /api/sources?q=<sealed>     -> { _hash } -> AES-CBC -> { sources: [ ... ] }
 *
 * So the source may never have been measured at all. This probe asks the API
 * directly, with the exact envelope the attic adapter implements, and reports:
 *
 *   1. does /api/servers answer at all, and with what status
 *   2. does the sealed envelope open with the recorded passphrase
 *   3. if not, can the passphrase be recovered from the site's own JS bundle
 *   4. which scrapers it lists, and which of those are RiveStream routes —
 *      because `rive-citadel` IS this board's source-1
 *   5. for the scrapers that are NOT RiveStream, what do they return
 *
 * The scraper list is the finding that matters. If nxsha's own lanes are a
 * different catalogue, it is a real source. If everything answers from
 * rivestream.app, it is the same pipe under a second name and must be refused.
 *
 * Writes research/nxsha-probe.json. Registers nothing.
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const OUT = 'research/nxsha-probe.json';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const ORIGINS = ['https://nxsha.space', 'https://web.nxsha.app'];
// Recorded from the retired adapter. Public front-end constants, tried in order.
const PASSES = [
  '38c8cd65d781936f4b9fe1fd985234fd7335699855051abf76ea3493bcfc0120',
  'f4488ab4da401203d23baa129fc546153898162524635d6776826d0c867ccaa3',
  'S8x!Jk4ZP1uG8$my',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** OpenSSL "Salted__" + AES-256-CBC, key material from iterated MD5. */
function derive(salt, pass) {
  let material = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (material.length < 48) {
    previous = crypto.createHash('md5').update(Buffer.concat([previous, Buffer.from(pass), salt])).digest();
    material = Buffer.concat([material, previous]);
  }
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}

function decodeWith(input, pass) {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) throw new Error('not-base64url');
  const bytes = Buffer.from(input, 'base64url');
  if (bytes.length < 32) throw new Error('too-short');
  if (bytes.subarray(0, 8).toString() !== 'Salted__') throw new Error('bad-magic');
  const { key, iv } = derive(bytes.subarray(8, 16), pass);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const plain = Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

function encode(body, pass = PASSES[0]) {
  const salt = crypto.randomBytes(8);
  const { key, iv } = derive(salt, pass);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const plain = JSON.stringify({ ...body, _req_ts: Date.now(), _req_salt: crypto.randomBytes(6).toString('base64url') });
  return Buffer.concat([Buffer.from('Salted__'), salt, cipher.update(plain), cipher.final()]).toString('base64url');
}

const DOMAIN = (raw) => {
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
};

async function getText(url, headers = {}, timeout = 20_000) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/html, */*', ...headers },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    });
    const text = await response.text();
    return { status: response.status, text, contentType: response.headers.get('content-type') };
  } catch (error) {
    const cause = error?.cause?.code ?? '';
    return { status: null, text: '', error: `${error?.name}: ${error?.message}${cause ? ` (${cause})` : ''}` };
  }
}

/** Read the rotated passphrase out of the site's own bundle, if the API is sealed with a new key. */
async function recoverPassphrase(origin, envelope) {
  const headers = { 'User-Agent': UA, Referer: `${origin}/` };
  const page = await getText(`${origin}/embed/movie/27205`, headers, 15_000);
  if (page.status !== 200) return { found: null, reason: `bundle page ${page.status ?? page.error}` };
  const chunks = [...page.text.matchAll(/\/_next\/(static\/chunks\/[A-Za-z0-9_.-]+\.js)/g)].map((m) => m[1]).slice(0, 16);
  if (!chunks.length) return { found: null, reason: 'no /_next chunks on the embed page' };
  const bodies = await Promise.all(
    chunks.map((path) => getText(`${origin}/_next/${path}`, headers, 12_000)),
  );
  const candidates = new Set();
  for (const body of bodies) for (const m of body.text.matchAll(/"([0-9a-f]{64})"/g)) candidates.add(m[1]);
  for (const candidate of candidates) {
    try {
      decodeWith(envelope, candidate);
      return { found: candidate.slice(0, 8) + '…', full: true, reason: null };
    } catch {
      /* not this one */
    }
  }
  return { found: null, reason: `${chunks.length} chunk(s), ${candidates.size} hex constant(s), none opened it` };
}

async function main() {
  console.log('nxsha probe,', new Date().toISOString());
  const report = { measuredAt: new Date().toISOString(), origins: [], notes: {} };

  const params = { tmdbId: '550', imdb_id: '', type: 'movie', season: 0, episode: 0 };

  for (const origin of ORIGINS) {
    const row = { origin, steps: [] };
    console.log(`\n— ${origin}`);

    // 0. The thing that got it rejected: the website.
    const watch = await getText(`${origin}/watch/movie/550`, {}, 15_000);
    row.steps.push({
      step: 'watch-page (the old verdict)',
      status: watch.status,
      bytes: watch.text.length,
      contentType: watch.contentType,
      error: watch.error,
    });

    // 1. The API it actually uses.
    await sleep(2000);
    const url = `${origin}/api/servers?q=${encodeURIComponent(encode(params))}`;
    const api = await getText(url, { Referer: `${origin}/`, Accept: 'application/json' }, 20_000);
    row.steps.push({
      step: 'api/servers',
      status: api.status,
      bytes: api.text.length,
      contentType: api.contentType,
      body: api.text.slice(0, 120),
      error: api.error,
    });

    if (api.status === 200) {
      let envelope;
      try {
        envelope = JSON.parse(api.text)._hash;
      } catch {
        envelope = null;
      }
      if (!envelope) {
        row.steps.push({ step: 'envelope', status: null, error: 'no _hash in the reply' });
      } else {
        let opened = null;
        let usedPass = null;
        for (const pass of PASSES) {
          try {
            opened = decodeWith(envelope, pass);
            usedPass = pass.slice(0, 8) + '…';
            break;
          } catch {
            /* try the next recorded key */
          }
        }
        if (!opened) {
          const recovered = await recoverPassphrase(origin, String(envelope));
          row.steps.push({ step: 'passphrase recovery', status: null, error: recovered.reason });
          if (recovered.full) {
            const full = await recoverPassphrase(origin, String(envelope));
            row.steps.push({ step: 'recovery', note: `key found but not returned by this run: ${full.reason ?? 'recovered'}` });
          }
        } else {
          row.steps.push({ step: 'passphrase', status: 200, note: `opened with ${usedPass}` });
        }
        if (opened) {
          const scrapers = [...new Set((opened.servers ?? []).map((s) => s?.scraper).filter(Boolean))];
          const rive = scrapers.filter((s) => /^rive-|citadel|primevids|flowcast|quasar|hindicast/i.test(s));
          const own = scrapers.filter((s) => !rive.includes(s));
          report.notes[origin] = {
            scrapers: scrapers.length,
            riveFamily: rive,
            ownFamily: own,
            payloadKeys: Object.keys(opened).slice(0, 8),
          };
          row.steps.push({
            step: 'payload',
            status: 200,
            note: `${scrapers.length} scraper(s): ${rive.length} RiveStream-family, ${own.length} its own`,
          });
          console.log(`  scrapers: ${scrapers.length} (${rive.length} rive-family, ${own.length} own)`);
          console.log(`  own lanes: ${own.join(', ') || '(none)'}`);

          // 2. One of its OWN lanes: what does it actually return?
          const probeLane = own.find((s) => !/embed/i.test(s)) ?? own[0];
          if (probeLane) {
            await sleep(3000);
            const sourcesUrl = `${origin}/api/sources?q=${encodeURIComponent(
              encode({ ...params, ex_lang: true, provider: probeLane }),
            )}`;
            const sources = await getText(sourcesUrl, { Referer: `${origin}/`, Accept: 'application/json' }, 20_000);
            let media = [];
            let openedSources = null;
            if (sources.status === 200) {
              try {
                const env2 = JSON.parse(sources.text)._hash;
                for (const pass of PASSES) {
                  try {
                    openedSources = decodeWith(env2, pass);
                    break;
                  } catch {
                    /* next */
                  }
                }
              } catch {
                /* no envelope */
              }
            }
            if (openedSources) {
              const rows = Array.isArray(openedSources.sources) ? openedSources.sources : [];
              media = rows
                .map((s) => s?.url)
                .filter((u) => typeof u === 'string' && /^https:\/\//.test(u))
                .slice(0, 8);
              report.notes[`${origin}:${probeLane}`] = {
                rows: rows.length,
                languages: [...new Set(rows.map((s) => String(s?.language ?? s?.label ?? '')).filter(Boolean))].slice(0, 8),
                mediaHosts: [...new Set(media.map((u) => new URL(u).hostname))].slice(0, 8),
                domains: [...new Set(media.map(DOMAIN).filter(Boolean))],
              };
              console.log(`  ${probeLane}: ${rows.length} row(s), hosts ${[...new Set(media.map((u) => new URL(u).hostname))].join(',') || 'none'}`);
            } else {
              row.steps.push({
                step: `sources:${probeLane}`,
                status: sources.status,
                bytes: sources.text.length,
                body: sources.text.slice(0, 100),
                error: sources.error ?? 'envelope did not open',
              });
              console.log(`  ${probeLane}: ${sources.status} — did not open`);
            }
            row.steps.push({
              step: `sources:${probeLane}`,
              status: sources.status,
              bytes: sources.text.length,
              media: media.length,
              domains: [...new Set(media.map(DOMAIN).filter(Boolean))],
            });
          }
        }
      }
    }

    for (const step of row.steps) {
      console.log(`  ${String(step.step).padEnd(28)} ${step.status ?? step.error ?? ''} ${step.note ?? ''}`.trim());
    }
    report.origins.push(row);
    await sleep(4000);
  }

  const touched = report.origins.some((o) => o.steps.some((s) => s.status === 200));
  if (!touched) {
    console.error('\nrefusing to write a report: nothing answered. No egress, or both front-ends are down.');
    process.exit(2);
  }
  await fs.writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
