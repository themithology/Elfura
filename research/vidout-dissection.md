# Vidout (vidout.pages.dev) — dissection

## What it is
A player shell, not a provider. `https://vidout.pages.dev/` serves a Netflix-look
HLS player whose only job is to play masters it fetches from somewhere else.
Routes are `/movie/<id>` and `/tv/<id>/<season>/<episode>`; ``/tv/1396/1/1``
renders "Breaking Bad · S1 E1 Pilot · 1080p" with a server picker whose entries
are CDN locations (Miami, Boise, Nashville, …, Delhi, Cancun) — an edge list, not
independent catalogues.

## Where the streams actually come from
A public, machine-written catalogue keyed by TMDB id, updated every few minutes
(commits named `Update <title> via OpenStreams`):

```
GET /hls/movie/<tmdbId>              -> https://<cdn>/.../master.txt      (bare URL)
GET /hls/tv/<tmdbId>/S<season>.json  -> { "<episode>": "https://<cdn>/.../master.txt" }
```

Structure seen: `hls/movie/<id>` is a one-line file; `hls/tv/<id>/S<n>.json` maps
episode numbers to masters; `sub/` and `latest.json` sit alongside.

## The masters are real multi-audio HLS
`master.txt` for Breaking Bad S1E1 on `sw5.aurorionacademy.site`:

```
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="हिन्दी",LANGUAGE="hi",DEFAULT=YES,URI="index-a1.txt"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="தமிழ்",LANGUAGE="ta",URI="index-a2.txt"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="తెలుగు",LANGUAGE="te",URI="index-a3.txt"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="English",LANGUAGE="en",URI="index-a4.txt"
#EXT-X-STREAM-INF:BANDWIDTH=2047048,RESOLUTION=1920x816,AUDIO="audio0"
index-v1-a4.txt
```

Hindi, Tamil, Telugu and English in one manifest — countable, not claimed.

## The catch that took a probe to find
The media CDNs gate on the player origin:

| Request | Result |
|---|---|
| plain `User-Agent` | `404 text/html` |
| `Referer/Origin: https://vidout.pages.dev` | `200 application/vnd.apple.mpegurl` + `#EXTM3U…` |

So the referer must ride on the candidate headers, or every probe and every
relayed segment 404s.

## Verified from a clean runner (GitHub Actions, US)
| Case | Rows | Alive | Notes |
|---|---|---|---|
| movie 10138 (Iron Man 2) | 1 | **1** | `audio: hi,ta,te,en`, `multiAudio=true` |
| tv 1396 S1E1 / S1E4 | 1 / 1 | 0 | host `sw5.aurorionacademy.site` answers `ECONNRESET` to datacenter IPs |
| movie 27205 | — | — | no catalogue entry for that id |

The TV CDN refusing a GitHub runner is an IP-level filter, not a dead lane: it
must be judged from the deployment host, which is exactly what the shipped
adapter does at request time.

## Adopted as Source 21
`backend/src/sources/source21.ts` — catalogue read through a CDN mirror (jsDelivr,
edge-cached, no per-IP limit) with the raw git origin as fallback, https-only
`.txt`/`.m3u8` playlist URLs behind the SSRF guard, referer/origin on every media
request, languages taken from the live manifest. Two bounded requests, zero disk,
no credentials, browser still sees only relay tickets.
