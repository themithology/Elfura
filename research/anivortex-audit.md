# AniVortex audit and Source 17

Audit: 14–15 November 2026. Research plus a working, live-verified adapter.

The sandbox here cannot reach `api.anivortex.in` directly (`curl` → status `000`), so route discovery
used GET probing through an external page fetcher and every live test ran on a GitHub Actions runner via
`.github/workflows/anivortex-probe.yml`. Results are committed by the workflow to
`research/anivortex-probe-report.md`.

**Live status (2026-11-15):** registration succeeds from a datacenter IP with the software
(self-signed) certificate path, all catalogue routes answer, and **movie** playback returns
manifest-reachable DASH streams with separate English/Hindi rows (Dune: Part Two 9 rows / 6 reachable;
Oppenheimer 4 rows / 4 reachable). **TV** rows resolve through the episode route but their CDN rejects
datacenter traffic with HTTP 426. No browser playback or spoken-language check has been performed.

## What AniVortex is

Not anime-only, despite the name. The CloudStream plugin `MyAniVortex` (`moviesallwatchdowanload-web/Anivortex-scrapper`,
`MyAniVortex.cs3` v10) declares `tvTypes = ["Movie", "TvSeries", "Anime", "AsianDrama"]` and language `hi`.
It is a single backend catalogue with OTT-platform rails (Netflix, MXPlayer, …), wrapped by a third-party
plugin, not an aggregator of independent hosts.

- App identity: `app.anivortex.mobile`, `version_name 5.0.1`, `version_code 503`, platform `android`.
- API base: `https://api.anivortex.in`.
- Metadata: TMDB (key embedded in the public plugin) used by the plugin for posters/plots only. The
  catalogue itself is addressed by AniVortex numeric title ids, **not** TMDB ids.

## Candidate clients and maintenance (checked before reuse)

| Repo | Type | Maintenance verdict |
|---|---|---|
| `codegeasse1/hikari` (200★) + `codegeasse1/hikari-extensions` | Hikari app + `.hiki` `anivortex` extension | Actively maintained (commits within a day; app releases v0.12.0 → 0.12.103), but young, single-maintainer and **unlicensed**. Its own extension notes playback is gated behind credentials exported from the CloudStream plugin. Reference only. |
| `moviesallwatchdowanload-web/Anivortex-scrapper` | CloudStream `.cs3` plugin + build files | **Not maintained**: one commit (2026-09-21), 0★, no CI, no releases, no license. Treated as a protocol artifact only. |
| `DiwasKhatri07/NepaliStream-CNC-Repo` | Automated decompiled CloudStream source archive | Maintained as an archive (commits every few minutes), 7★. Decompiled code has no clean license; used as documentation, never as a dependency. |
| `akedidi/zangetsu`, `penpoyem-lab/Linkflow-` | Forks that merely list/mention the domain | Not relevant. |

No Nuvio or Stremio addon exists for AniVortex: public code search for `anivortex` in JavaScript,
TypeScript, Dart and Python returns only an unrelated React site, and a repo-scoped search inside the
Nuvio plugin repository `Skywave22/Plugins-TJ` returns zero hits. There was nothing to port, which is
why Source 17 is written from the wire protocol instead.

## Route map (empirically probed, unauthenticated)

Router responds **before** the signature middleware, so a 404 proves a route is absent while the
`invalid_installation_signature` body proves a route exists and is gated.

| Route | Method | Observation |
|---|---|---|
| `/api/v1/install/challenge` | POST | exists (GET → `Method Not Allowed`) |
| `/api/v1/install/register` | POST | exists (GET → `Method Not Allowed`) |
| `/api/v1/push/installation` | POST | exists, signed |
| `/api/v1/catalog/home?catalog=&include_adult=` | GET | exists, signed |
| `/api/v1/catalog/explore` | GET | exists, signed |
| `/api/v1/catalog/ott-platforms/{slug}/titles` | GET | exists, signed |
| `/api/v1/search?q=` | GET | exists, signed |
| `/api/v1/titles/{id}` | GET | exists, signed |
| `/api/v1/titles/{id}/watch` | GET | exists, signed |
| `/api/v1/titles/{id}/playback` | GET | exists, signed |
| `/api/v1/seasons/{id}` | GET | **404 — absent**, contrary to the Hikari extension |
| `/api/v1/titles/{id}/seasons`, `/episodes`, `/stream`, `/playback/{x}` | GET | **404 — absent** |

## Protocol

Install (no signature yet), JSON `content-type`, `user-agent: Dart/3.10 (dart:io)`:

1. `POST /api/v1/install/challenge` with `{"platform":"android","package_name":"app.anivortex.mobile","version_name":"5.0.1","version_code":503}`
   → `{challenge_id, challenge, expires_at, server_time}`; `challenge` is base64url without padding.
2. Generate an EC P-256 keypair and a **self-signed leaf certificate** (the reference client's software
   path; CN `Android Keystore Key`, `ecdsa-with-SHA256`, validity −1 day/+365 days).
3. `proof_signature = base64url(ECDSA-SHA256("ANIVORTEX-INSTALL-REGISTER-V1\n" + challenge_id + "\n" + base64url(sha256(challenge_bytes))))`
4. `POST /api/v1/install/register` with `{"challenge_id", "certificate_chain":[leaf, leaf], "proof_signature"}`
   → `{installation_id, key_id, registered_at, server_time}`.

Signed requests (every catalogue/playback call):

```
canonical = "ANIVORTEX-SIGNED-REQUEST-V1\n" + installation_id + "\n" + key_id + "\n" +
            timestamp_seconds + "\n" + request_id_uuid + "\n" + METHOD + "\n" + path +
            "\n" + sorted_query + "\n" + sha256hex(body | empty)
signature = base64url(ECDSA-SHA256(canonical))
headers: user-agent, x-anivortex-installation-id, x-anivortex-key-id,
         x-anivortex-request-id, x-anivortex-timestamp, x-anivortex-signature
sorted_query: keys ascending, `k=v` joined with `&`, values Java-URL-encoded with `+` → `%20`
```

The keystore-attested hardware path exists as a fallback for real devices. The software path is what the
plugin attempts first, which is why a server-side installation is plausible at all — but **whether the
API accepts a self-signed software chain from a datacenter IP is unverified**, and is exactly what
`scripts/anivortex-probe.mjs` tests.

## Playback payload shapes (from the decompiled models)

- `PlaybackResponse { title_id, episode, selected_server_key, server, server_options }`
- `PlaybackServer { key, name, languages, subtitles }`
- `PlaybackLanguage { code, name, playback, download_options }`
- `PlaybackStreams { qualities }` → `QualityStream { quality, url, type, headers, expires_at, fallback_urls }`

Server names, language codes and quality labels are **provider claims**. Nothing in the payload proves a
separate audio rendition or the spoken language.

## Source 17 implementation

- `backend/src/anivortex-auth.ts` — canonical signing, self-signed certificate construction (own DER
  encoder), installation registration, credential loading from env. No code copied from any plugin.
- `backend/src/sources/source17.ts` — search by title → confirm kind (`movie`/`anime_movie` vs episodic)
  and year → `/titles/{id}/watch` for episode ids → `/titles/{id}/playback` (up to three query shapes,
  plus at most two announced `server_options`), then the standard liveness/SSRF filtering. Language labels
  are attached as `claimedAudioLang`/`audioLabel` only; `audioLang` stays unset until a manifest proves it.
- Disabled by default: `ELFURA_ANIVORTEX_ENABLED=1` **and** `ELFURA_ANIVORTEX_INSTALL_ID` /
  `_KEY_ID` / `_PRIVATE_KEY`. Without credentials the adapter emits one diagnostic and makes no request.
- Tests (`backend/test/anivortex-adapter.mjs`, mocked): canonical encoding, signature verification against
  the exact canonical string, self-signed certificate parsing and verification, registration handshake
  and proof verification against the presented certificate, title matching, episode-id extraction,
  SSRF rejection, label-only audio handling, and the no-credentials path. **No live upstream test.**

## Live results (GitHub Actions run 43688997936)

| Probe | Result |
|---|---|
| `install/challenge` + `install/register` (software key, CI IP) | **success** — `installation_id` and `key_id` returned |
| `/api/v1/search?q=Dune: Part Two` | 200, `{query, items[]}`; `items[]` carries `audio_badge`, `content_type`, `release_year` |
| `/api/v1/titles/{id}` | 200, metadata only (no TMDB id, no episode list) |
| `/api/v1/titles/{id}/watch` | 200, `{seasons:[{id, season_number, episode_count}], available_servers}` — **no episode ids** |
| `/api/v1/seasons/{seasonId}/episodes` | 200, `{episodes:[{id, episode_number, available_servers}], next_cursor, has_more}` |
| `/api/v1/titles/{id}/playback` (movie) | 200, `server` + `server_options` (`ok_video`, `moviebox_web`) |
| `/api/v1/titles/{id}/playback?season=&episode=` | **400** `invalid_query: only episode_id, include_adult, server, and language are supported` |
| `/api/v1/titles/{id}/playback` (TV, no id) | **400** `episode_required` |
| Adapter + liveness, Dune: Part Two | 9 rows (en 3, hi 3, und 2, te 1), 6 manifest-reachable DASH, ~3.5 s |
| Adapter + liveness, Oppenheimer | 4 rows (en 2, hi 2), 4 manifest-reachable DASH, ~3.1 s |
| Adapter + liveness, Breaking Bad S1E1 | 2 rows (en, hi) via the episode route, **0 manifest-reachable** — CDN returns HTTP 426 |

Streams live at `language.playback.sources[]` (`format: "dash"`, per-language URL, UA header) with
progressive MP4s in `language.download_options[]` (4K/2K/1080p). Media hosts are `*.okcdn.ru` /
`ok6-*.vkuser.net` — OK.ru-family CDNs, not AniVortex's own edges.

**DASH manifests report zero audio renditions** (`audioRenditions=0`, `langs=[]`) because each language is
its own stream with a single audio adaptation set. Manifest rendition discovery therefore cannot
corroborate the language, which is why the operator decided on 2026-11-15 that these labels are trusted:
`audioLang` is set from the label, and `ELFURA_ANIVORTEX_TRUST_LABELS=0` reverts to claim-only. This is
the documented exception in `RULES.md` §5.1, and it does mean a mislabelled upstream row would be offered
as that language.

## Open questions / next steps

1. **TV playback is blocked from datacenter IPs.** Episode rows resolve correctly (the season/episode
   route works) but their media host `sbcdnw.hakunaymatata.com` answers `HTTP 426 Forbidden` to every
   header combination tried (as-provided, moviebox referer/origin, iPhone UA, byte-range, API referer —
   the last even produced `429`). That is an edge/IP gate, not a header bug, so Source 17 currently
   contributes movies and dies quietly on TV. Worth re-testing from the Pterodactyl host IP; if it holds
   there too, TV support needs a different upstream lane.
2. The `moviebox_web` server (labelled "Spiral" in episode payloads) is reachable in `server_options` but
   was never separately parsed — decide whether it adds independent coverage.
3. Verify real browser playback and spoken language for at least one Hindi row.
4. Title mapping is name-based because the catalogue exposes no TMDB id; measure mismatch rates on a sample.
5. Rate limits: the client handles HTTP 429 on challenge, so registration must never be retried in a loop.
6. Installation credentials must be minted per deployment with `node scripts/anivortex-register.mjs`; the
   CI probe deliberately uses throwaway installations.
