# AniVortex audit and Source 17

Audit: 14 November 2026. Research and a prototype adapter. **No live playback, spoken-language or
latency verification was possible from the sandbox**: direct egress to `api.anivortex.in` is blocked
here (`curl` returns status `000`), so only GET route probing through an external page fetcher was
performed. Nothing below claims a working multi-audio source.

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

## Open questions / next steps

1. Does `install/register` accept a software (non-attested) chain from a datacenter IP, or does it require
   hardware attestation? Run `.github/workflows/anivortex-probe.yml`.
2. Which playback query shape does the API accept (`episode_id` vs `season`+`episode`, `server`), and what
   does `server_options` contain?
3. Do returned manifests carry real selectable audio renditions (Hindi prioritised), and are segments
   reachable through the relay from the deployment?
4. Title mapping is name-based because the catalogue exposes no TMDB id; verify mismatch rates on a sample.
5. Rate limits: the client handles HTTP 429 on challenge, so registration must not be retried in a loop.
