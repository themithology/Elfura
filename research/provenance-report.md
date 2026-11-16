# Provenance + Sources 14/12 expansion report

Run: 43817427477 on arena/4d781e96-elfura at 2026-11-16T06:35:18Z

```
# provenance + expansion probe — 2026-11-16T06:32:42.832Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto 2086c4c2 — manifest paretocdn.site → segment paretocdn.site (CDN serving its own segments (single origin))
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 1 alive
    · hls auto 65fc0f5f — manifest prx-1560-ant-t.vmpx.online → segment prx-1560-ant-t.vmpx.online (relay host serving its own segments)
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto 01050429 — manifest prx-1560-ant-t.vmpx.online → segment prx-1560-ant-t.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 829ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 209ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR5W7ut2VgWB3RBNRvTy2F1Y._YoEfsd1/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 23ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 47ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 43ms rows=0 root=error formats=none hosts=none
- awsind: http=200 13ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 43ms rows=0 root=error formats=none hosts=none
- stvv: http=200 21ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 32ms rows=0 root=error formats=none hosts=none
## 2b. Source 14 citadel language lanes (every row)
- citadel movie:579974: http=200 rows=4
    · 480p | English |  → img1.fcxmb.com/480/index_preview_266.m3u8
    · 480p | English |  → img1.hscow.com/480/index_preview_287.m3u8
    · 480p | Tamil |  → img1.hscow.com/480/index_preview_287.m3u8
    · 480p | Telugu |  → img1.fcxmb.com/480/index_preview_266.m3u8
- citadel movie:872906: http=200 rows=6
    · 720p | Hindi |  → img1.hscow.com/720/index_287.m3u8
    · 720p | Kannada |  → img1.fcxmb.com/720/index_266.m3u8
    · 720p | Tamil |  → img1.hscow.com/Jawan_tamil1080/index_287.m3u8
    · 480p | Hindi |  → img1.hscow.com/480/index_287.m3u8
    · 480p | Kannada |  → img1.hscow.com/480/index_287.m3u8
    · 480p | Telugu |  → img1.hscow.com/480/index_287.m3u8
- citadel movie:693134: http=200 rows=10
    · 720p | English |  → img1.hscow.com/720/index_287.m3u8
    · 720p | Hindi |  → img1.hscow.com/Hindi_720/index_287.m3u8
    · 720p | Kannada |  → img1.fcxmb.com/Kan_720/index_266.m3u8
    · 720p | Tamil |  → img1.hscow.com/Tamil_720/index_287.m3u8
    · 720p | Telugu |  → img1.hscow.com/Tel_720/index_287.m3u8
    · 480p | English |  → img1.hscow.com/480/index_287.m3u8
    · 480p | Hindi |  → img1.fcxmb.com/Hindi_480/index_266.m3u8
    · 480p | Kannada |  → img1.hscow.com/Kan_480/index_287.m3u8
    · 480p | Tamil |  → img1.hscow.com/Tamil_480/index_287.m3u8
    · 480p | Telugu |  → img1.hscow.com/Tel_480/index_287.m3u8
- citadel tv:1396: http=200 rows=2
    · 720p | Hindi |  → img1.hscow.com/720/index_287.m3u8
    · 480p | Hindi |  → img1.hscow.com/480/index_287.m3u8


## 2c. Shared-URL citadel rows — one file with several audio tracks?
- movie:872906: 6 row(s) in 6 distinct url(s)
    · img1.hscow.com/720/index_287.m3u8 [720p Hindi]: http=200 variants=0 audioRenditions=0
    · img1.hscow.com/720/index_287.m3u8 [720p Kannada]: http=200 variants=0 audioRenditions=0
    · img1.hscow.com/Jawan_tamil1080/index_287.m3u8 [720p Tamil]: http=200 variants=0 audioRenditions=0
    · img1.hscow.com/480/index_287.m3u8 [480p Hindi]: http=200 variants=0 audioRenditions=0
- movie:693134: 10 row(s) in 10 distinct url(s)
    · img1.fcxmb.com/720/index_266.m3u8 [720p English]: http=200 variants=0 audioRenditions=0
    · img1.hscow.com/Hindi_720/index_287.m3u8 [720p Hindi]: http=200 variants=0 audioRenditions=0
    · img1.hscow.com/Kan_720/index_287.m3u8 [720p Kannada]: http=200 variants=0 audioRenditions=0
    · img1.hscow.com/Tamil_720/index_287.m3u8 [720p Tamil]: http=200 variants=0 audioRenditions=0
- tv:1396: 2 row(s) in 2 distinct url(s)
    · img1.hscow.com/720/index_287.m3u8 [720p Hindi]: http=200 variants=0 audioRenditions=0
    · img1.hscow.com/480/index_287.m3u8 [480p Hindi]: http=200 variants=0 audioRenditions=0

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_cpGkWjE0g | hls@self/api/stream/v1_rqlNixOV8 | hls@self/api/stream/v1_yi12-NkO2
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_65FBC23wy
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_9va--nwSk
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_ERV_249Dv
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_6U4HaZ5QN
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_038mcq2g3 | hls@self/api/stream/v1__2_eQ9OnE
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment silent-mud-0029.cvscvp56747.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_c9ndeDG18
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_7fxiK4kf9 | hls@self/api/stream/v1_bF5zOUkCB | hls@self/api/stream/v1_3iyxgAbFG
    liveness: 0/4 alive (4 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_AyGD56P47 | hls@self/api/stream/v1_StMjdgg74 | hls@self/api/stream/v1_xm5AnYdgZ
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_DdZ-lkwJO
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_RAszaLG4T
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_VbtOuPxSc
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_iWkCuX3HX
    liveness: 0/1 alive (0 confirmed dead)
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_EhhYoBYkk
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_cTEMb2EMV | hls@self/api/stream/v1_V2Tnvt4RB
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment shy-mud-ddec.vvjeoz74386.workers.dev (edge → different segment host)
- pluto: http=200 rows=0 
- helios: http=200 rows=5 hls@self/api/stream/v1_NSTzGT7IA | hls@self/api/stream/v1_agQkyR32c | hls@self/api/stream/v1_cMtvk2NFi
    liveness: 0/5 alive (4 confirmed dead)

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 1 candidate(s) in 4103ms
    diag: rows=3,manifestReachable=1 flowcast=200/3 primevids=200/3 guru=200/0 citadel=timeout quasar=timeout hindicast=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-14 movie:693134: 0 candidate(s) in 4101ms
    diag: rows=2,manifestReachable=0 guru=200/0 primevids=200/2 citadel=timeout flowcast=timeout quasar=timeout hindicast=timeout
    audio: 
    quality: none · hosts: 
- source-14 movie:913290: 1 candidate(s) in 4102ms
    diag: rows=3,manifestReachable=1 primevids=200/3 guru=200/0 flowcast=200/2 citadel=timeout quasar=timeout hindicast=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-12 tv:1396: 4 candidate(s) in 4543ms
    diag: candidates=15,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 3 candidate(s) in 5604ms
    diag: candidates=16,reachable=3
    audio: unlabelled:3
    quality: auto · hosts: vidzen.fun
## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)
- source-1: 1 row(s), 1 alive in 767ms · gzip.rousav.tech
- source-2: 8 row(s), 5 alive in 1465ms · embed.vidrift.in,mb.vidrift.net,gzip.rousav.tech
- source-3: 0 row(s), 0 alive in 218ms
- source-4: 0 row(s), 0 alive in 159ms
- source-5: 0 row(s), 0 alive in 70ms
- source-7: 0 row(s), 0 alive in 39ms
- source-8: 1 row(s), 1 alive in 3313ms · img1.hscow.com
- source-9: 0 row(s), 0 alive in 64ms
- source-10: 0 row(s), 0 alive in 53ms
- source-11: 0 row(s), 0 alive in 286ms
- source-12: 0 row(s), 0 alive in 8209ms
- source-13: 0 row(s), 0 alive in 72ms
- source-14: 3 row(s), 3 alive in 4103ms · img1.hscow.com,cdn.slowcloud.live
- source-15: 0 row(s), 0 alive in 229ms
- source-16: 0 row(s), 0 alive in 1ms
- source-17: 0 row(s), 0 alive in 0ms
- source-18: 0 row(s), 0 alive in 641ms
- source-19: 0 row(s), 0 alive in 372ms
- source-20: 0 row(s), 0 alive in 229ms
- source-21: 0 row(s), 0 alive in 946ms
- summary: 4/20 lanes produced rows for this episode from a US runner
## 6. Source 21 — Vidout catalogue, live
- tv 1396 S1E1: 1 row(s), 0 alive in 776ms · host sw5.aurorionacademy.site
- tv 1396 S1E4: 1 row(s), 0 alive in 516ms · host sw5.aurorionacademy.site
- tv 66732 S4E1: 1 row(s), 1 alive in 500ms · host dd2stliwt0bc.homechefrecipes.sbs
    audio: hi,en · multiAudio=true
- tv 76479 S1E1: no catalogue entry (684ms)
- movie 10138: 1 row(s), 1 alive in 173ms · host wt4pjiive9agjpl.planetexploration.space
    audio: hi,ta,te,en · multiAudio=true
- movie 27205: no catalogue entry (561ms)
## 7. Source 21 transport checks (status codes only)
- tv host plain: 0  TypeError:ECONNRESET
- tv host referred: 0  TypeError:ECONNRESET
- movie host plain: 404 text/html <html>\n<head><title>404 Not Found</titl
- movie host referred: 200 application/vnd.apple.mpegurl #EXTM3U\n\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-I
```

## Source health — movie 550 (Fight Club)
```
[selftest] TMDB_API_KEY is not set: adapters that need title/year fallback will report 0.

[selftest] movie/550: 4/20 sources returned candidates

source-2   raw=4     282ms :: 2 req · vidrock.net 403 · embed.vidrift.in 200
source-14  raw=2    4105ms :: 10 req · scrapper.rivestream.app 200×3 · scrapper.rivestream.app timeout×3 · cdn1.slowcloud.live TypeError · img1.hscow.com 200
source-1   raw=1     306ms :: 1 req · vidbolt.xyz 200
source-20  raw=1    2396ms :: 3 req · patient-cherry.workerscloud32.workers.dev 200×2 · moviesapi.to 200
source-10  raw=0     116ms :: 6 req · new.vidnest.fun 403×6
source-11  raw=0     356ms :: 1 req · streamdata.vaplayer.ru 404
source-12  raw=0    2601ms :: 1 req · vidzen.fun timeout
source-13  raw=0     125ms :: 1 req · freakyniki.elaxo.lol 403
source-15  raw=0     324ms :: 1 req · mapple.fun 200
source-16  raw=0       3ms :: 0 req
source-17  raw=0       3ms :: 0 req
source-18  raw=0    1124ms :: 2 req · blakiteapi.xyz 200×2
source-19  raw=0       2ms :: 0 req
source-21  raw=0     551ms :: 2 req · cdn.jsdelivr.net 200 · suw.halcyoncreative.site TypeError
source-3   raw=0     176ms :: 2 req · vidsync.pro 200×2
source-4   raw=0      62ms :: 1 req · bingr.one 403
source-5   raw=0     118ms :: 1 req · nxsha.space 403
source-7   raw=0     117ms :: 1 req · nxsha.space 403
source-8   raw=0    3287ms :: 6 req · core.vidzee.wtf 200×2 · core.vidzee.wtf 400 · core.vidzee.wtf 404 · cdn.slowcloud.live 200
source-9   raw=0     114ms :: 1 req · vixsrc.to 403
```

## Source health — tv 1396 S1E1 (Breaking Bad)
```
[selftest] TMDB_API_KEY is not set: adapters that need title/year fallback will report 0.

[selftest] tv/1396: 5/20 sources returned candidates

source-2   raw=5     276ms :: 2 req · vidrock.net 403 · embed.vidrift.in 200
source-12  raw=4    5093ms :: 30 req · vidzen.fun 200×17 · vidzen.fun 403×8 · vidzen.fun timeout×2 · vidzen.fun 404
source-14  raw=3    4104ms :: 11 req · scrapper.rivestream.app 200×4 · scrapper.rivestream.app timeout×2 · img1.hscow.com 200×2 · cdn1.slowcloud.live TypeError
source-1   raw=1     172ms :: 1 req · vidbolt.xyz 200
source-8   raw=1    3372ms :: 7 req · core.vidzee.wtf 200×3 · core.vidzee.wtf 400 · img1.hscow.com 200 · cdn.slowcloud.live 200
source-10  raw=0     107ms :: 6 req · new.vidnest.fun 403×6
source-11  raw=0     338ms :: 1 req · streamdata.vaplayer.ru 404
source-13  raw=0     104ms :: 1 req · freakyniki.elaxo.lol 403
source-15  raw=0     445ms :: 1 req · mapple.fun 200
source-16  raw=0       3ms :: 0 req
source-17  raw=0       3ms :: 0 req
source-18  raw=0    1214ms :: 2 req · blakiteapi.xyz 200×2
source-19  raw=0       2ms :: 0 req
source-20  raw=0     297ms :: 1 req · moviesapi.to 404
source-21  raw=0    1552ms :: 2 req · cdn.jsdelivr.net 200 · sw5.aurorionacademy.site TypeError
source-3   raw=0     156ms :: 2 req · vidsync.pro 200×2
source-4   raw=0     104ms :: 1 req · bingr.one 403
source-5   raw=0     127ms :: 1 req · nxsha.space 403
source-7   raw=0     118ms :: 1 req · nxsha.space 403
source-9   raw=0      98ms :: 1 req · vixsrc.to 403
```
