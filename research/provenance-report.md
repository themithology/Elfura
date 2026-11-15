# Provenance + Sources 14/12 expansion report

Run: 43728492462 on arena/399224d8-elfura at 2026-11-15T15:13:55Z

```
# provenance + expansion probe — 2026-11-15T15:11:44.714Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto 40d11fd4 — manifest paretocdn.site → segment paretocdn.site (CDN serving its own segments (single origin))
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 1 alive
    · hls auto 5d2900f3 — manifest prx-1331-ant-q.vmpx.online → segment prx-1331-ant-q.vmpx.online (relay host serving its own segments)
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto 22aaf1bb — manifest prx-1331-ant-q.vmpx.online → segment prx-1331-ant-q.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1680ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 180ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR-ZrKBL3khocwiYE9V04lRI.cHLztBAa/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 899ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 425ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 45ms rows=0 root=error formats=none hosts=none
- awsind: http=200 23ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 20ms rows=0 root=error formats=none hosts=none
- stvv: http=200 19ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 23ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_IB-18ltkQ | hls@self/api/stream/v1_REndrbVgq | hls@self/api/stream/v1_NUVER6O-g
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_2Xa-lIL09
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_SZH5xGy7Y
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_Ueyuc7gr6
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_K6TdPbkvr
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_Pnh28_oWJ | hls@self/api/stream/v1__i5leyTC4
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment proxystream5.ms0p508k5idx.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_F06mO_zz7
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_37pwjuvQ_ | hls@self/api/stream/v1_jUwheNYxt | hls@self/api/stream/v1_4OWHy4dAo
    liveness: 0/4 alive (4 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_O5yCgBmEO | hls@self/api/stream/v1_zuXL0eljQ | hls@self/api/stream/v1_Zf0T-Oc7X
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_QAsD15I3J
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_B48w3Ui6L
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_4mm_DDYry
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_4Vp37Uhab
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_ZOVz5C-4J
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_iY5wWshoa | hls@self/api/stream/v1_Zo383wgcy
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen2.mu9wy80qtb9f.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_XwQS3BBSK
    liveness: 0/1 alive (1 confirmed dead)
- helios: http=200 rows=5 hls@self/api/stream/v1_GDsWl5DyS | hls@self/api/stream/v1_1F3i2dehP | hls@self/api/stream/v1_bbq3BOMWB
    liveness: 0/5 alive (4 confirmed dead)

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 3 candidate(s) in 4105ms
    diag: rows=5,manifestReachable=3 flowcast=200/3 primevids=200/3 guru=200/0 citadel=200/2 quasar=timeout hindicast=timeout
    audio: hi:2 unlabelled:1
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live
- source-14 movie:693134: 0 candidate(s) in 4101ms
    diag: rows=2,manifestReachable=0 primevids=200/2 guru=200/0 citadel=timeout flowcast=timeout quasar=timeout hindicast=timeout
    audio: 
    quality: none · hosts: 
- source-14 movie:913290: 1 candidate(s) in 4102ms
    diag: rows=3,manifestReachable=1 primevids=200/3 guru=200/0 flowcast=200/2 citadel=timeout quasar=timeout hindicast=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-12 tv:1396: 1 candidate(s) in 5608ms
    diag: candidates=15,reachable=1
    audio: unlabelled:1
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 1 candidate(s) in 5103ms
    diag: candidates=17,reachable=1
    audio: unlabelled:1
    quality: auto · hosts: vidzen.fun
## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)
- source-1: 1 row(s), 0 alive in 806ms · gzip.rousav.tech
- source-2: 5 row(s), 0 alive in 577ms · embed.vidrift.in,gzip.rousav.tech
- source-3: 0 row(s), 0 alive in 282ms
- source-4: 0 row(s), 0 alive in 191ms
- source-5: 0 row(s), 0 alive in 239ms
- source-7: 0 row(s), 0 alive in 595ms
- source-8: 1 row(s), 1 alive in 3367ms · img1.hscow.com
- source-9: 0 row(s), 0 alive in 441ms
- source-10: 0 row(s), 0 alive in 3761ms
- source-11: 0 row(s), 0 alive in 397ms
- source-12: 1 row(s), 1 alive in 5607ms · vidzen.fun
- source-13: 0 row(s), 0 alive in 168ms
- source-14: 3 row(s), 3 alive in 4103ms · img1.hscow.com,cdn.slowcloud.live
- source-15: 0 row(s), 0 alive in 649ms
- source-16: 0 row(s), 0 alive in 0ms
- source-17: 0 row(s), 0 alive in 0ms
- source-18: 0 row(s), 0 alive in 532ms
- source-19: 0 row(s), 0 alive in 655ms
- source-20: 0 row(s), 0 alive in 206ms
- summary: 5/19 lanes produced rows for this episode from a US runner
```
