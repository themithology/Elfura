# Provenance + Sources 14/12 expansion report

Run: 43734450856 on arena/399224d8-elfura at 2026-11-15T16:18:04Z

```
# provenance + expansion probe — 2026-11-15T16:15:40.279Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto 71bd4e3f — manifest paretocdn.site → segment paretocdn.site (CDN serving its own segments (single origin))
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 1 alive
    · hls auto e5e25809 — manifest prx-1331-ant-q.vmpx.online → segment prx-1331-ant-q.vmpx.online (relay host serving its own segments)
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto 7bbdcdf4 — manifest prx-1331-ant-q.vmpx.online → segment prx-1331-ant-q.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1233ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 164ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR0UMXK9Mfv0X3_XpH6JGn3k.ZoRIfh5C/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 1141ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 156ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 33ms rows=0 root=error formats=none hosts=none
- awsind: http=200 20ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 9ms rows=0 root=error formats=none hosts=none
- stvv: http=200 21ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 9ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_w88ILQSHz | hls@self/api/stream/v1_NXdkmUfyx | hls@self/api/stream/v1_22ESOkMNy
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_A-gGmTXCb
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_HJm8ljCs-
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_fa9bEuPhN
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_ij1AUMMR8
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_9HyahA7Yd | hls@self/api/stream/v1_y2j55EqxN
    liveness: 1/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment fancy-glade-dee3.mvmcn27rmqym.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_eVP-OqPw0
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_qyw-Meinf | hls@self/api/stream/v1_zhxOiz_Q3 | hls@self/api/stream/v1_NLeBcG2pC
    liveness: 0/4 alive (2 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_7vYQzzf5l | hls@self/api/stream/v1_jq_qebRaN | hls@self/api/stream/v1_L52sgov4g
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_tidlo5ZJr
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_U9xx4tbQo
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_PPZP4MuVM
    liveness: 0/1 alive (0 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_KoZOkK1Ib
    liveness: 0/1 alive (0 confirmed dead)
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1__jqeEGgyg
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_zIXxFNNK_ | hls@self/api/stream/v1_TVQ9CFz0W
    liveness: 0/2 alive (2 confirmed dead)
- pluto: http=200 rows=1 hls@self/api/stream/v1_Zb7N-j7vI
    liveness: 0/1 alive (1 confirmed dead)
- helios: http=200 rows=5 hls@self/api/stream/v1_BkhB29xLb | hls@self/api/stream/v1_eu57pHOW_ | hls@self/api/stream/v1_HEpZmZaRX
    liveness: 0/5 alive (2 confirmed dead)

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 1 candidate(s) in 4104ms
    diag: rows=3,manifestReachable=1 flowcast=200/3 guru=200/0 primevids=200/3 quasar=timeout hindicast=timeout citadel=200/0
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-14 movie:693134: 0 candidate(s) in 4102ms
    diag: rows=2,manifestReachable=0 guru=200/0 primevids=200/2 citadel=timeout flowcast=timeout quasar=timeout hindicast=timeout
    audio: 
    quality: none · hosts: 
- source-14 movie:913290: 1 candidate(s) in 4103ms
    diag: rows=3,manifestReachable=1 primevids=200/3 guru=200/0 flowcast=200/2 citadel=timeout quasar=timeout hindicast=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-12 tv:1396: 4 candidate(s) in 4672ms
    diag: candidates=15,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 1 candidate(s) in 4257ms
    diag: candidates=17,reachable=1
    audio: unlabelled:1
    quality: auto · hosts: vidzen.fun
## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)
- source-1: 1 row(s), 1 alive in 990ms · gzip.rousav.tech
- source-2: 5 row(s), 5 alive in 1394ms · embed.vidrift.in,gzip.rousav.tech
- source-3: 0 row(s), 0 alive in 153ms
- source-4: 0 row(s), 0 alive in 66ms
- source-5: 0 row(s), 0 alive in 215ms
- source-7: 0 row(s), 0 alive in 216ms
- source-8: 1 row(s), 1 alive in 3613ms · img1.hscow.com
- source-9: 0 row(s), 0 alive in 643ms
- source-10: 0 row(s), 0 alive in 1756ms
- source-11: 0 row(s), 0 alive in 505ms
- source-12: 0 row(s), 0 alive in 2601ms
- source-13: 0 row(s), 0 alive in 296ms
- source-14: 3 row(s), 3 alive in 4104ms · img1.hscow.com,cdn.slowcloud.live
- source-15: 0 row(s), 0 alive in 459ms
- source-16: 0 row(s), 0 alive in 0ms
- source-17: 0 row(s), 0 alive in 1ms
- source-18: 0 row(s), 0 alive in 635ms
- source-19: 0 row(s), 0 alive in 1560ms
- source-20: 0 row(s), 0 alive in 650ms
- source-21: 0 row(s), 0 alive in 459ms
- summary: 4/20 lanes produced rows for this episode from a US runner
## 6. Source 21 — Vidout catalogue, live
- tv 1396 S1E1: 1 row(s), 0 alive in 900ms · host sw5.aurorionacademy.site
- tv 1396 S1E4: 1 row(s), 0 alive in 272ms · host sw5.aurorionacademy.site
- movie 10138: 1 row(s), 0 alive in 217ms · host wt4pjiive9agjpl.planetexploration.space
- movie 27205: no catalogue entry (487ms)
## 7. Source 21 transport checks (status codes only)
- tv host plain: 0  TypeError:ECONNRESET
- tv host referred: 0  TypeError:ECONNRESET
- movie host plain: 404 text/html <html>\n<head><title>404 Not Found</titl
- movie host referred: 200 application/vnd.apple.mpegurl #EXTM3U\n\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-I
```
