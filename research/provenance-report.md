# Provenance + Sources 14/12 expansion report

Run: 43728888269 on arena/399224d8-elfura at 2026-11-15T15:17:56Z

```
# provenance + expansion probe — 2026-11-15T15:16:00.560Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 0 alive
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 0 alive
- source-19 tv:95479:Jujutsu Kaisen:1:1: 0 row(s), 0 alive

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1033ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 78ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR2ZaYcP8EDmoxjuPgqfaHdQ.sq6SJwR1/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 950ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 380ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 57ms rows=0 root=error formats=none hosts=none
- awsind: http=200 47ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 35ms rows=0 root=error formats=none hosts=none
- stvv: http=200 22ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 13ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_0iWMgX_o3 | hls@self/api/stream/v1_yPqdrpWaU | hls@self/api/stream/v1_dejoqEwFJ
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_KemDMNkiB
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_VZ0Wbk_c4
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_A0a3sWydR
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_0ees_ceHO
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_1oFoaeX5Y | hls@self/api/stream/v1_RlaxJ8ViP
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment gentle-pond-ab57.muo7ct1o3brm.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_cCHZnV-QO
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_1KBEAmlQi | hls@self/api/stream/v1_K5B19H6Ft | hls@self/api/stream/v1_yrrwIunYz
    liveness: 0/4 alive (4 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_5_0BsFFNt | hls@self/api/stream/v1_l-uEVpsHY | hls@self/api/stream/v1_27wO-0T1K
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_jYCKvavpt
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_GvAkx6qY8
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_lmYeDgZmj
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_bcSkMqGkR
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_r-ywiVZi5
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_HyfD6jk1P | hls@self/api/stream/v1_z-ioyH9wT
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment fancy-glade-dee3.mvmcn27rmqym.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_QuBxU061J
    liveness: 0/1 alive (1 confirmed dead)
- helios: http=200 rows=5 hls@self/api/stream/v1_gPXOGKOGa | hls@self/api/stream/v1_i5y9C_1wh | hls@self/api/stream/v1_wGpsYmdTJ
    liveness: 0/5 alive (4 confirmed dead)

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 3 candidate(s) in 4106ms
    diag: rows=5,manifestReachable=3 flowcast=200/3 guru=200/0 primevids=200/3 citadel=200/2 quasar=timeout hindicast=timeout
    audio: hi:2 unlabelled:1
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live
- source-14 movie:693134: 0 candidate(s) in 4102ms
    diag: rows=2,manifestReachable=0 primevids=200/2 guru=200/0 citadel=timeout flowcast=timeout quasar=timeout hindicast=timeout
    audio: 
    quality: none · hosts: 
- source-14 movie:913290: 10 candidate(s) in 4109ms
    diag: rows=12,manifestReachable=10 primevids=200/3 guru=200/0 flowcast=200/2 citadel=200/10 quasar=timeout hindicast=timeout
    audio: bn:2 hi:2 ta:2 te:2 en:1 unlabelled:1
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live
- source-12 tv:1396: 4 candidate(s) in 4078ms
    diag: candidates=15,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 3 candidate(s) in 3726ms
    diag: candidates=17,reachable=3
    audio: unlabelled:3
    quality: auto · hosts: vidzen.fun
## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)
- source-1: 1 row(s), 1 alive in 541ms · gzip.rousav.tech
- source-2: 5 row(s), 5 alive in 2088ms · embed.vidrift.in,gzip.rousav.tech
- source-3: 0 row(s), 0 alive in 179ms
- source-4: 0 row(s), 0 alive in 126ms
- source-5: 0 row(s), 0 alive in 292ms
- source-7: 0 row(s), 0 alive in 279ms
- source-8: 1 row(s), 1 alive in 3480ms · img1.hscow.com
- source-9: 0 row(s), 0 alive in 463ms
- source-10: 0 row(s), 0 alive in 1970ms
- source-11: 0 row(s), 0 alive in 369ms
- source-12: 0 row(s), 0 alive in 2602ms
- source-13: 0 row(s), 0 alive in 181ms
- source-14: 3 row(s), 3 alive in 4102ms · img1.hscow.com,cdn.slowcloud.live
- source-15: 0 row(s), 0 alive in 346ms
- source-16: 0 row(s), 0 alive in 0ms
- source-17: 0 row(s), 0 alive in 0ms
- source-18: 0 row(s), 0 alive in 575ms
- source-19: 0 row(s), 0 alive in 526ms
- source-20: 0 row(s), 0 alive in 218ms
- summary: 4/19 lanes produced rows for this episode from a US runner
```
