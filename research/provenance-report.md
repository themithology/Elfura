# Provenance + Sources 14/12 expansion report

Run: 43719959656 on arena/399224d8-elfura at 2026-11-15T13:39:38Z

```
# provenance + expansion probe — 2026-11-15T13:37:35.737Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto 2365cd88 — manifest patient-cherry.workerscloud32.workers.dev → segment patient-cherry.workerscloud32.workers.dev (relay host serving its own segments)
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 1 alive
    · hls auto 4f435bd2 — manifest prx-1331-ant-q.vmpx.online → segment prx-1331-ant-q.vmpx.online (relay host serving its own segments)
- source-19 tv:95479:Jujutsu Kaisen:1:1: 0 row(s), 0 alive

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1337ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 204ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR1pSfdXEPBPD_RwjQXKJutE.GVfJUutT/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 2891ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 302ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 142ms rows=0 root=error formats=none hosts=none
- awsind: http=200 82ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 16ms rows=0 root=error formats=none hosts=none
- stvv: http=200 33ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 11ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_6G0EsYTSZ | hls@self/api/stream/v1_7m3iie22T | hls@self/api/stream/v1_NtrMDoJTS
    liveness: 0/4 alive (0 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_VR-VOi4nd
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_RpJo88JuF
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_DS-X2Uw2C
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_6WP97u_w1
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_Fm9KEaDhw | hls@self/api/stream/v1_9jGeCVIIu
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment patient-bush-91f5.muo7ej8od9bi.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_CCkTaFeHo
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_nOzHcu1Vu | hls@self/api/stream/v1_j4gUUCHqd | hls@self/api/stream/v1_sjQWDNMWQ
    liveness: 0/4 alive (3 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=0 
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_QZKvTyCbI
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_9Mmy8G7IF
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_Qdj5-7R6-
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_z90Vz9Rsm
    liveness: 0/1 alive (0 confirmed dead)
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_a36ol7JLL
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_Z3Lv3i8XY | hls@self/api/stream/v1_6IseUnFef
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment falling-pine-39a4.xdbypass.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_OEslWZHB0
    liveness: 0/1 alive (1 confirmed dead)
- helios: http=200 rows=0 

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 3 candidate(s) in 4105ms
    diag: rows=5,manifestReachable=3 guru=200/0 flowcast=200/3 primevids=200/3 citadel=200/2 quasar=timeout hindicast=timeout
    audio: hi:2 unlabelled:1
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live
- source-14 movie:693134: 0 candidate(s) in 4102ms
    diag: rows=2,manifestReachable=0 guru=200/0 primevids=200/2 citadel=timeout flowcast=timeout quasar=timeout hindicast=timeout
    audio: 
    quality: none · hosts: 
- source-14 movie:913290: 1 candidate(s) in 4102ms
    diag: rows=3,manifestReachable=1 primevids=200/3 guru=200/0 flowcast=200/2 citadel=timeout quasar=timeout hindicast=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-12 tv:1396: 4 candidate(s) in 5522ms
    diag: candidates=15,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 1 candidate(s) in 4179ms
    diag: candidates=8,reachable=1
    audio: unlabelled:1
    quality: auto · hosts: vidzen.fun
```
