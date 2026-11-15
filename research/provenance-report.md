# Provenance + Sources 14/12 expansion report

Run: 43734014521 on arena/399224d8-elfura at 2026-11-15T16:13:24Z

```
# provenance + expansion probe — 2026-11-15T16:11:10.113Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto 2c2d17bd — manifest paretocdn.site → segment paretocdn.site (CDN serving its own segments (single origin))
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 0 row(s), 0 alive
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto 11f367cd — manifest prx-1350-ant-d.vmpx.online → segment prx-1350-ant-d.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1307ms rows=3 root=data formats=hls:3 hosts=img1.hscow.com:3
    labels: 720p | Hindi|Citadel ; 480p | English|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 222ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR5WtjTFNFqVJDyN3keFqFPU.arRgT7Kk/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 43ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 96ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 46ms rows=0 root=error formats=none hosts=none
- awsind: http=200 28ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 26ms rows=0 root=error formats=none hosts=none
- stvv: http=200 31ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 26ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1__8JorKnbk | hls@self/api/stream/v1_gT3MOHFWd | hls@self/api/stream/v1_vE6tJ408z
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_YyEjcVOTP
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_Yq6ZYZGzD
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_xhJwvZoO5
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_m5sjRxBWz
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_lZJlN7M7q | hls@self/api/stream/v1_FLJolpHr5
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest http=403
- pluto: http=200 rows=1 hls@self/api/stream/v1_cOa5gdiYU
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_njbEC1r0y | hls@self/api/stream/v1_aqgQqAjB< | hls@self/api/stream/v1_nHVkYItcb
    liveness: 0/4 alive (4 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_8IabwSXoo | hls@self/api/stream/v1_jBS_0aboO | hls@self/api/stream/v1_ScrT02JVY
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_z7tUQI42T
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_jjghNJFA5
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_SB2DHUIUS
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_AhiSrOgFM
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_VYWapSgvY
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_jy1qG354m | hls@self/api/stream/v1_plEa4SAdq
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment v1.streamsitegp.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_sIWWszEyC
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=5 hls@self/api/stream/v1_pU6kgaJP7 | hls@self/api/stream/v1_IjjGdfCGB | hls@self/api/stream/v1_Y9UTYfL1X
    liveness: 0/5 alive (4 confirmed dead)

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 1 candidate(s) in 4103ms
    diag: rows=3,manifestReachable=1 guru=200/0 flowcast=200/3 primevids=200/3 citadel=timeout quasar=timeout hindicast=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-14 movie:693134: 0 candidate(s) in 4102ms
    diag: rows=2,manifestReachable=0 guru=200/0 primevids=200/2 citadel=timeout flowcast=timeout quasar=timeout hindicast=timeout
    audio: 
    quality: none · hosts: 
- source-14 movie:913290: 1 candidate(s) in 4102ms
    diag: rows=3,manifestReachable=1 guru=200/0 primevids=200/3 flowcast=200/2 citadel=timeout quasar=timeout hindicast=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-12 tv:1396: 4 candidate(s) in 5199ms
    diag: candidates=15,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 1 candidate(s) in 3704ms
    diag: candidates=17,reachable=1
    audio: unlabelled:1
    quality: auto · hosts: vidzen.fun
## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)
- source-1: 1 row(s), 1 alive in 708ms · gzip.rousav.tech
- source-2: 5 row(s), 5 alive in 1479ms · embed.vidrift.in,gzip.rousav.tech
- source-3: 0 row(s), 0 alive in 211ms
- source-4: 0 row(s), 0 alive in 163ms
- source-5: 0 row(s), 0 alive in 687ms
- source-7: 0 row(s), 0 alive in 338ms
- source-8: 1 row(s), 1 alive in 3263ms · img1.hscow.com
- source-9: 0 row(s), 0 alive in 518ms
- source-10: 0 row(s), 0 alive in 1784ms
- source-11: 0 row(s), 0 alive in 446ms
- source-12: 2 row(s), 2 alive in 5603ms · vidzen.fun
- source-13: 0 row(s), 0 alive in 105ms
- source-14: 3 row(s), 3 alive in 4104ms · img1.hscow.com,cdn.slowcloud.live
- source-15: 0 row(s), 0 alive in 670ms
- source-16: 0 row(s), 0 alive in 1ms
- source-17: 0 row(s), 0 alive in 0ms
- source-18: 0 row(s), 0 alive in 657ms
- source-19: 0 row(s), 0 alive in 1346ms
- source-20: 0 row(s), 0 alive in 225ms
- source-21: 0 row(s), 0 alive in 1360ms
- summary: 5/20 lanes produced rows for this episode from a US runner
## 6. Source 21 — Vidout catalogue, live
- tv 1396 S1E1: 1 row(s), 0 alive in 969ms · host sw5.aurorionacademy.site
- tv 1396 S1E4: 1 row(s), 0 alive in 449ms · host sw5.aurorionacademy.site
- movie 10138: 1 row(s), 0 alive in 704ms · host wt4pjiive9agjpl.planetexploration.space
- movie 27205: no catalogue entry (1638ms)
## 7. Source 21 transport checks (status codes only)
- plain UA: master 0  TypeError
    (no variant line parsed)
- with vidout referer: master 0  TypeError
    (no variant line parsed)
```
