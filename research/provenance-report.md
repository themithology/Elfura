# Provenance + Sources 14/12 expansion report

Run: 43696923033 on arena/399224d8-elfura at 2026-11-15T09:01:05Z

```
# provenance + expansion probe — 2026-11-15T08:58:11.214Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto 876723a6 — manifest patient-cherry.workerscloud32.workers.dev → segment patient-cherry.workerscloud32.workers.dev (relay host serving its own segments)
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 1 alive
    · hls auto 99c3f5ca — manifest prx-1566-ant-r.vmpx.online → segment prx-1566-ant-r.vmpx.online (relay host serving its own segments)
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto 5adb714a — manifest prx-1566-ant-r.vmpx.online → segment prx-1566-ant-r.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1107ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 134ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR4YStZaO0y38pHckqF3I1CA.tToL4-rW/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 64ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 48ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 17ms rows=0 root=error formats=none hosts=none
- awsind: http=200 19ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 7ms rows=0 root=error formats=none hosts=none
- stvv: http=200 10ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 21ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (Breaking Bad S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_RDlN_clZ- | hls@self/api/stream/v1_psFSnAA-p | hls@self/api/stream/v1_6V76UcFl_
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_dXyrQRHx_
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_NYtSQHSvH
    liveness: 0/1 alive (0 confirmed dead)
- venus: http=200 rows=0 
- saturn: error TimeoutError
- mercury: error TimeoutError
- neptune: error TimeoutError
- earth: error TimeoutError
- uranus: http=200 rows=2 hls@self/api/stream/v1_62LcuuOpi | hls@self/api/stream/v1_xqy0mGxzw
    liveness: 0/2 alive (0 confirmed dead)
- pluto: http=200 rows=1 hls@self/api/stream/v1_c5Ajnr5VG
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_bYJ2cHg8k | hls@self/api/stream/v1_fL3-C4WGu | hls@self/api/stream/v1_xj0UQdGxC
    liveness: 0/4 alive (4 confirmed dead)
## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 4 candidate(s) in 3904ms
    diag: rows=5,manifestReachable=4 flowcast=200/3 guru=200/0 primevids=200/3 citadel=200/2 quasar=timeout hindicast=timeout
    audio: hi:2 unlabelled:2
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live,cdn2.slowcloud.live
- source-14 movie:693134: 11 candidate(s) in 3801ms
    diag: rows=12,manifestReachable=11 primevids=200/2 guru=200/0 citadel=200/10 flowcast=timeout quasar=timeout hindicast=timeout
    audio: en:2 hi:2 kn:2 ta:2 te:2 unlabelled:1
    quality: auto · hosts: img1.fcxmb.com,img1.hscow.com,cdn2.slowcloud.live
- source-14 movie:913290: 11 candidate(s) in 4076ms
    diag: rows=12,manifestReachable=11 primevids=200/3 guru=200/0 flowcast=200/2 citadel=200/10 quasar=timeout hindicast=timeout
    audio: bn:2 hi:2 ta:2 te:2 en:1 unlabelled:2
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live,cdn2.slowcloud.live
- source-12 tv:1396: 3 candidate(s) in 5433ms
    diag: candidates=15,reachable=3
    audio: unlabelled:3
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 0 candidate(s) in 5602ms
    diag: candidates=7,reachable=0
    audio: 
    quality: none · hosts: 
```
