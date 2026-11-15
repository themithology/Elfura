# Provenance + Sources 14/12 expansion report

Run: 43733578730 on arena/399224d8-elfura at 2026-11-15T16:09:00Z

```
# provenance + expansion probe — 2026-11-15T16:06:30.507Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 0 alive
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 1 alive
    · hls auto 8d284acb — manifest prx-1350-ant-d.vmpx.online → segment prx-1350-ant-d.vmpx.online (relay host serving its own segments)
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto 1f669a3d — manifest prx-1350-ant-d.vmpx.online → segment prx-1350-ant-d.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1547ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 121ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR820ud7scIy8Nhk0UXrX2Jw.76cRAYks/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 192ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 83ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 59ms rows=0 root=error formats=none hosts=none
- awsind: http=200 25ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 66ms rows=0 root=error formats=none hosts=none
- stvv: http=200 20ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 35ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_Jp12K93DC | hls@self/api/stream/v1_-oP6cVaGY | hls@self/api/stream/v1_R0bZQihQw
    liveness: 0/4 alive (2 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_1zHj7uSv9
    liveness: 0/1 alive (0 confirmed dead)
- jupiter: http=200 rows=1 hls@self/api/stream/v1_U2uTS19ek
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_fuUdg-uU6
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_hNM3SXqV1
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_S979njwxH | hls@self/api/stream/v1_815y281Bb
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment rapid-feather-11de.mue2rxjlgdcr.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_KaxeQfc-9
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_xe79r2hBv | hls@self/api/stream/v1_UEBOMxeqS | hls@self/api/stream/v1_VebUlqHOM
    liveness: 0/4 alive (4 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_qnYRbGXh1 | hls@self/api/stream/v1_W_JwmBEqB | hls@self/api/stream/v1_-IZSf9St3
    liveness: 0/4 alive (3 confirmed dead)
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_thxBeQYae
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_p9GOih57h
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_1L8JQoHqS
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_mnM4Vq7FF
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_Wurp69avR
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_tPkOOAjQh | hls@self/api/stream/v1_vryE6-bfv
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment curly-butterfly-41bf.bpdsyr14353.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_iVypOtNSZ
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=5 hls@self/api/stream/v1_gKzziOVsR | hls@self/api/stream/v1_mZXwVFJeN | hls@self/api/stream/v1_KJIDCYNxW
    liveness: 0/5 alive (4 confirmed dead)

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 3 candidate(s) in 4106ms
    diag: rows=5,manifestReachable=3 primevids=200/3 flowcast=200/3 guru=200/0 citadel=200/2 quasar=timeout hindicast=timeout
    audio: hi:2 unlabelled:1
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live
- source-14 movie:693134: 0 candidate(s) in 4102ms
    diag: rows=2,manifestReachable=0 primevids=200/2 guru=200/0 citadel=timeout flowcast=timeout quasar=timeout hindicast=timeout
    audio: 
    quality: none · hosts: 
- source-14 movie:913290: 1 candidate(s) in 4102ms
    diag: rows=3,manifestReachable=1 flowcast=200/2 guru=200/0 primevids=200/3 citadel=timeout quasar=timeout hindicast=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-12 tv:1396: 4 candidate(s) in 3885ms
    diag: candidates=15,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 1 candidate(s) in 3884ms
    diag: candidates=17,reachable=1
    audio: unlabelled:1
    quality: auto · hosts: vidzen.fun
## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)
- source-1: 1 row(s), 1 alive in 1077ms · gzip.rousav.tech
- source-2: 5 row(s), 5 alive in 1458ms · embed.vidrift.in,gzip.rousav.tech
- source-3: 0 row(s), 0 alive in 307ms
- source-4: 0 row(s), 0 alive in 433ms
- source-5: 0 row(s), 0 alive in 689ms
- source-7: 0 row(s), 0 alive in 528ms
- source-8: 1 row(s), 1 alive in 3264ms · img1.hscow.com
- source-9: 0 row(s), 0 alive in 478ms
- source-10: 0 row(s), 0 alive in 1571ms
- source-11: 0 row(s), 0 alive in 409ms
- source-12: 0 row(s), 0 alive in 2601ms
- source-13: 0 row(s), 0 alive in 127ms
- source-14: 3 row(s), 3 alive in 4102ms · img1.hscow.com,cdn.slowcloud.live
- source-15: 0 row(s), 0 alive in 426ms
- source-16: 0 row(s), 0 alive in 0ms
- source-17: 0 row(s), 0 alive in 1ms
- source-18: 0 row(s), 0 alive in 517ms
- source-19: 0 row(s), 0 alive in 7000ms
- source-20: 0 row(s), 0 alive in 237ms
- source-21: 0 row(s), 0 alive in 1091ms
- summary: 4/20 lanes produced rows for this episode from a US runner
## 6. Source 21 — Vidout catalogue, live
- tv 1396 S1E1: 1 row(s), 0 alive in 1564ms · host sw5.aurorionacademy.site
- tv 1396 S1E4: 1 row(s), 0 alive in 2132ms · host sw5.aurorionacademy.site
- movie 10138: 1 row(s), 0 alive in 843ms · host wt4pjiive9agjpl.planetexploration.space
- movie 27205: no catalogue entry (458ms)
```
