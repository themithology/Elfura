# Provenance + Sources 14/12 expansion report

Run: 43816563977 on arena/4d781e96-elfura at 2026-11-16T06:27:27Z

```
# provenance + expansion probe — 2026-11-16T06:24:58.146Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto 37626107 — manifest paretocdn.site → segment paretocdn.site (CDN serving its own segments (single origin))
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 1 alive
    · hls auto 505d119c — manifest prx-1560-ant-t.vmpx.online → segment prx-1560-ant-t.vmpx.online (relay host serving its own segments)
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto 9743d8ba — manifest prx-1560-ant-t.vmpx.online → segment prx-1560-ant-t.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 900ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 115ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStRyu757veD5ThnFTDDi4H3-M.oerKJcPz/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 29ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 69ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 36ms rows=0 root=error formats=none hosts=none
- awsind: http=200 20ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 17ms rows=0 root=error formats=none hosts=none
- stvv: http=200 16ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 14ms rows=0 root=error formats=none hosts=none
## 2b. Source 14 citadel language lanes (every row)
- citadel 579974: http=200 rows=0
- citadel 872906: http=200 rows=0
- citadel 693134: http=200 rows=0
- citadel 1396: http=200 rows=2
    · 720p | Hindi |  → img1.hscow.com/720/index_287.m3u8
    · 480p | Hindi |  → img1.hscow.com/480/index_287.m3u8


## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_7XSIg-YWF | hls@self/api/stream/v1_D8QBZa2Ab | hls@self/api/stream/v1_Mru0gBsZC
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_rHGxcAQMm
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_mexmBI<n>
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: error TimeoutError
- mercury: http=200 rows=1 hls@self/api/stream/v1_MZTd4ZuEX
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_la68kPf8U
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_DEvNdajU1 | hls@self/api/stream/v1_mKaNWxgB7
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment royal-bonus-d2df.ozlhsp28886.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_fRFe8cKbW
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_U3-HxWu4S | hls@self/api/stream/v1_DmOwZ3B5w | hls@self/api/stream/v1_p48XK98Cq
    liveness: 0/4 alive (4 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_w5sA-NRkx | hls@self/api/stream/v1_8v_pZf-gD | hls@self/api/stream/v1_feic1nS3J
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_grH9C_WZo
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_j7KZGjp9O
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_pUMWd1Hg0
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_NOHiqtVuT
    liveness: 0/1 alive (0 confirmed dead)
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_TDMFV2GKj
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_RvvdGEKTR | hls@self/api/stream/v1_DKXipyhiL
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment morning-sun-9bbb.mvmcsih5z2sd.workers.dev (edge → different segment host)
- pluto: error TimeoutError
- helios: http=200 rows=5 hls@self/api/stream/v1_x2CcbOWig | hls@self/api/stream/v1_xeDCmjVUH | hls@self/api/stream/v1_A8NdoWuQG
    liveness: 1/5 alive (4 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 3 candidate(s) in 4104ms
    diag: rows=5,manifestReachable=3 guru=200/0 flowcast=200/3 primevids=200/3 citadel=200/2 quasar=timeout hindicast=timeout
    audio: hi:2 unlabelled:1
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live
- source-14 movie:693134: 0 candidate(s) in 4102ms
    diag: rows=2,manifestReachable=0 guru=200/0 primevids=200/2 citadel=timeout flowcast=timeout quasar=timeout hindicast=timeout
    audio: 
    quality: none · hosts: 
- source-14 movie:913290: 1 candidate(s) in 4102ms
    diag: rows=3,manifestReachable=1 flowcast=200/2 guru=200/0 primevids=200/3 citadel=timeout quasar=timeout hindicast=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-12 tv:1396: 0 candidate(s) in 2601ms
    diag: candidates=0,reachable=0
    audio: 
    quality: none · hosts: 
- source-12 movie:872585: 0 candidate(s) in 2601ms
    diag: candidates=0,reachable=0
    audio: 
    quality: none · hosts: 
## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)
- source-1: 1 row(s), 1 alive in 243ms · gzip.rousav.tech
- source-2: 8 row(s), 5 alive in 1166ms · embed.vidrift.in,mb.vidrift.net,gzip.rousav.tech
- source-3: 0 row(s), 0 alive in 211ms
- source-4: 0 row(s), 0 alive in 316ms
- source-5: 0 row(s), 0 alive in 615ms
- source-7: 0 row(s), 0 alive in 175ms
- source-8: 1 row(s), 1 alive in 3465ms · img1.hscow.com
- source-9: 0 row(s), 0 alive in 498ms
- source-10: 0 row(s), 0 alive in 1868ms
- source-11: 0 row(s), 0 alive in 369ms
- source-12: 4 row(s), 4 alive in 5150ms · vidzen.fun
- source-13: 0 row(s), 0 alive in 199ms
- source-14: 3 row(s), 3 alive in 4102ms · img1.hscow.com,cdn.slowcloud.live
- source-15: 0 row(s), 0 alive in 350ms
- source-16: 0 row(s), 0 alive in 0ms
- source-17: 0 row(s), 0 alive in 1ms
- source-18: 0 row(s), 0 alive in 563ms
- source-19: 0 row(s), 0 alive in 590ms
- source-20: 0 row(s), 0 alive in 196ms
- source-21: 0 row(s), 0 alive in 409ms
- summary: 5/20 lanes produced rows for this episode from a US runner
## 6. Source 21 — Vidout catalogue, live
- tv 1396 S1E1: 1 row(s), 0 alive in 1211ms · host sw5.aurorionacademy.site
- tv 1396 S1E4: 1 row(s), 0 alive in 994ms · host sw5.aurorionacademy.site
- tv 66732 S4E1: 1 row(s), 1 alive in 636ms · host dd2stliwt0bc.homechefrecipes.sbs
    audio: hi,en · multiAudio=true
- tv 76479 S1E1: no catalogue entry (482ms)
- movie 10138: 1 row(s), 1 alive in 205ms · host wt4pjiive9agjpl.planetexploration.space
    audio: hi,ta,te,en · multiAudio=true
- movie 27205: no catalogue entry (378ms)
## 7. Source 21 transport checks (status codes only)
- tv host plain: 0  TypeError:ECONNRESET
- tv host referred: 0  TypeError:ECONNRESET
- movie host plain: 404 text/html <html>\n<head><title>404 Not Found</titl
- movie host referred: 200 application/vnd.apple.mpegurl #EXTM3U\n\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-I
```

## Source health — movie 550 (Fight Club)
```
[selftest] TMDB_API_KEY is not set: adapters that need title/year fallback will report 0.

[selftest] movie/550: 6/20 sources returned candidates

source-2   raw=4     293ms :: 2 req · vidrock.net 403 · embed.vidrift.in 200
source-10  raw=3    1052ms :: 19 req · embed.vidrift.net 200×12 · new.vidnest.fun 200×4 · new.vidnest.fun 502×2 · i-arch-400.geffe448mik.com 404
source-12  raw=3    3868ms :: 31 req · vidzen.fun 200×17 · vidzen.fun 403×12 · vidzen.fun 502 · vidzen.fun timeout
source-1   raw=1     135ms :: 1 req · vidbolt.xyz 200
source-14  raw=1    4104ms :: 9 req · scrapper.rivestream.app 200×3 · scrapper.rivestream.app timeout×3 · cdn1.slowcloud.live TypeError · cdn.slowcloud.live 200
source-20  raw=1    1447ms :: 3 req · paretocdn.site 200×2 · moviesapi.to 200
source-11  raw=0     491ms :: 1 req · streamdata.vaplayer.ru 404
source-13  raw=0      80ms :: 1 req · freakyniki.elaxo.lol 403
source-15  raw=0     212ms :: 1 req · mapple.fun 200
source-16  raw=0       4ms :: 0 req
source-17  raw=0       3ms :: 0 req
source-18  raw=0    1004ms :: 2 req · blakiteapi.xyz 200×2
source-19  raw=0       2ms :: 0 req
source-21  raw=0    3178ms :: 2 req · cdn.jsdelivr.net 200 · suw.halcyoncreative.site timeout
source-3   raw=0     144ms :: 2 req · vidsync.pro 200×2
source-4   raw=0     112ms :: 1 req · bingr.one 403
source-5   raw=0     223ms :: 1 req · nxsha.space 200
source-7   raw=0     193ms :: 1 req · nxsha.space 200
source-8   raw=0    3325ms :: 6 req · core.vidzee.wtf 200×2 · core.vidzee.wtf 400 · core.vidzee.wtf 404 · cdn.slowcloud.live 200
source-9   raw=0     429ms :: 2 req · vixsrc.to 200×2
```

## Source health — tv 1396 S1E1 (Breaking Bad)
```
[selftest] TMDB_API_KEY is not set: adapters that need title/year fallback will report 0.

[selftest] tv/1396: 5/20 sources returned candidates

source-2   raw=5     282ms :: 2 req · vidrock.net 403 · embed.vidrift.in 200
source-12  raw=4    5422ms :: 30 req · vidzen.fun 200×17 · vidzen.fun 403×8 · vidzen.fun timeout×2 · vidzen.fun 404
source-14  raw=3    4104ms :: 11 req · scrapper.rivestream.app 200×4 · scrapper.rivestream.app timeout×2 · img1.hscow.com 200×2 · cdn.slowcloud.live 200
source-1   raw=1     141ms :: 1 req · vidbolt.xyz 200
source-8   raw=1    3340ms :: 7 req · core.vidzee.wtf 200×3 · core.vidzee.wtf 400 · cdn.slowcloud.live 200 · img1.hscow.com 200
source-10  raw=0    1739ms :: 12 req · embed.vidrift.net 404×4 · new.vidnest.fun 200×3 · new.vidnest.fun 502×3 · i-arch-400.geffe448mik.com 404×2
source-11  raw=0     267ms :: 1 req · streamdata.vaplayer.ru 404
source-13  raw=0      84ms :: 1 req · freakyniki.elaxo.lol 403
source-15  raw=0     355ms :: 1 req · mapple.fun 200
source-16  raw=0       4ms :: 0 req
source-17  raw=0       2ms :: 0 req
source-18  raw=0    1009ms :: 2 req · blakiteapi.xyz 200×2
source-19  raw=0       2ms :: 0 req
source-20  raw=0     222ms :: 1 req · moviesapi.to 404
source-21  raw=0    1853ms :: 2 req · cdn.jsdelivr.net 200 · sw5.aurorionacademy.site TypeError
source-3   raw=0     195ms :: 2 req · vidsync.pro 200×2
source-4   raw=0     127ms :: 1 req · bingr.one 403
source-5   raw=0     219ms :: 1 req · nxsha.space 200
source-7   raw=0     207ms :: 1 req · nxsha.space 200
source-9   raw=0     434ms :: 2 req · vixsrc.to 200×2
```
