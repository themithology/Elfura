# Provenance + Sources 14/12 expansion report

Run: 43697430885 on arena/399224d8-elfura at 2026-11-15T09:06:37Z

```
# provenance + expansion probe — 2026-11-15T09:04:29.459Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto 79db1730 — manifest patient-cherry.workerscloud32.workers.dev → segment patient-cherry.workerscloud32.workers.dev (relay host serving its own segments)
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 1 alive
    · hls auto 6437d043 — manifest prx-1559-ant.vmpx.online → segment prx-1559-ant.vmpx.online (relay host serving its own segments)
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto 92cc09ff — manifest prx-1559-ant.vmpx.online → segment prx-1559-ant.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1446ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 75ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR305ZYUMqY5pijcnQfyxRFA.3eyLFIJb/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 33ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 48ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 20ms rows=0 root=error formats=none hosts=none
- awsind: http=200 60ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 19ms rows=0 root=error formats=none hosts=none
- stvv: http=200 17ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 22ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_oi-mqNErH | hls@self/api/stream/v1_y2gdrWZOH | hls@self/api/stream/v1_tI<n>t6VG
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_nRs4-5t9K
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_QsiyNPYn3
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_KRd1WsXfH
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_5VEZxvzCi
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_aG1EjS2Wi | hls@self/api/stream/v1_5lXwv5sy9
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment v2.streamsitexp.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_cHeh3yJev
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_dlCsl82zN | hls@self/api/stream/v1_lX7gp04Zd | hls@self/api/stream/v1_cSonrT1N-
    liveness: 0/4 alive (4 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=0 
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1__bTz_p2zt
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_k_UutLX80
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_vxSP8csjc
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_JV79scvbV
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_BvCs_IxM0
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_nkzpKUAST | hls@self/api/stream/v1_7_MF2Pa0_
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment white-dream-9394.mvievyhp0bfk.workers.dev (edge → different segment host)
- pluto: error TimeoutError
- helios: http=200 rows=0 

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 4 candidate(s) in 3826ms
    diag: rows=5,manifestReachable=4 guru=200/0 flowcast=200/3 primevids=200/3 citadel=200/2 quasar=timeout hindicast=timeout
    audio: hi:2 unlabelled:2
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live,cdn2.slowcloud.live
- source-14 movie:693134: 11 candidate(s) in 4052ms
    diag: rows=12,manifestReachable=11 guru=200/0 primevids=200/2 citadel=200/10 flowcast=timeout quasar=timeout hindicast=timeout
    audio: en:2 hi:2 kn:2 ta:2 te:2 unlabelled:1
    quality: auto · hosts: img1.hscow.com,img1.fcxmb.com,cdn2.slowcloud.live
- source-14 movie:913290: 11 candidate(s) in 3972ms
    diag: rows=12,manifestReachable=11 flowcast=200/2 guru=200/0 primevids=200/3 citadel=200/10 quasar=timeout hindicast=timeout
    audio: bn:2 hi:2 ta:2 te:2 en:1 unlabelled:2
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live,cdn2.slowcloud.live
- source-12 tv:1396: 4 candidate(s) in 5567ms
    diag: candidates=15,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 4 candidate(s) in 5545ms
    diag: candidates=7,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
```
