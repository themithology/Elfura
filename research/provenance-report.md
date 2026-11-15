# Provenance + Sources 14/12 expansion report

Run: 43697862001 on arena/399224d8-elfura at 2026-11-15T09:12:16Z

```
# provenance + expansion probe — 2026-11-15T09:09:38.214Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto 00e65f90 — manifest patient-cherry.workerscloud32.workers.dev → segment patient-cherry.workerscloud32.workers.dev (relay host serving its own segments)
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 1 alive
    · hls auto 8d0beaf8 — manifest prx-1559-ant.vmpx.online → segment prx-1559-ant.vmpx.online (relay host serving its own segments)
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto 489702c1 — manifest prx-1559-ant.vmpx.online → segment prx-1559-ant.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 916ms rows=3 root=data formats=hls:3 hosts=img1.hscow.com:3
    labels: 720p | English|Citadel ; 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 56ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR0seZStDpdeRLJ_cN8_u63I.0SMITJmC/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 61ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 48ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 41ms rows=0 root=error formats=none hosts=none
- awsind: http=200 24ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 15ms rows=0 root=error formats=none hosts=none
- stvv: http=200 11ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 23ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_hqOb4cKey | hls@self/api/stream/v1_11Nu1JnBA | hls@self/api/stream/v1_NkvXUgPSx
    liveness: 0/4 alive (0 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_ar7OTkBPR
    liveness: 0/1 alive (0 confirmed dead)
- jupiter: http=200 rows=1 hls@self/api/stream/v1_cs7Z9oTXI
    liveness: 0/1 alive (0 confirmed dead)
- venus: error TimeoutError
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_fuYAIITVN
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_xX_9_LkDD
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_DFbYYck4E | hls@self/api/stream/v1_Wqh-YzqF6
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment odd-hill-ab44.mu9x0xmi36ix.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_ezw1_jz6O
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_J_GYOoiHT | hls@self/api/stream/v1_iVB8ZF689 | hls@self/api/stream/v1_G-nWUTLJG
    liveness: 0/4 alive (4 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=0 
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_CmaQXCsoq
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_VbUGNeyR_
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_JlYh7gOHN
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_LmXDnY1p3
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_E3dMKn852
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_owVxQeYI7 | hls@self/api/stream/v1_xJiDa96P4
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment curly-butterfly-41bf.bpdsyr14353.workers.dev (edge → different segment host)
- pluto: error TimeoutError
- helios: http=200 rows=0 

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 4 candidate(s) in 4175ms
    diag: rows=5,manifestReachable=4 flowcast=200/3 primevids=200/3 guru=200/0 citadel=200/2 quasar=timeout hindicast=timeout
    audio: hi:2 unlabelled:2
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live,cdn2.slowcloud.live
- source-14 movie:693134: 11 candidate(s) in 3992ms
    diag: rows=12,manifestReachable=11 guru=200/0 primevids=200/2 citadel=200/10 flowcast=timeout quasar=timeout hindicast=timeout
    audio: en:2 hi:2 kn:2 ta:2 te:2 unlabelled:1
    quality: auto · hosts: img1.fcxmb.com,img1.hscow.com,cdn2.slowcloud.live
- source-14 movie:913290: 11 candidate(s) in 3912ms
    diag: rows=12,manifestReachable=11 guru=200/0 primevids=200/3 flowcast=200/2 citadel=200/10 quasar=timeout hindicast=timeout
    audio: bn:2 hi:2 ta:2 te:2 en:1 unlabelled:2
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live,cdn2.slowcloud.live
- source-12 tv:1396: 4 candidate(s) in 5305ms
    diag: candidates=15,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 1 candidate(s) in 5602ms
    diag: candidates=7,reachable=1
    audio: unlabelled:1
    quality: auto · hosts: vidzen.fun
```
