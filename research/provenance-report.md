# Provenance + Sources 14/12 expansion report

Run: 43813329087 on arena/4d781e96-elfura at 2026-11-16T05:57:37Z

```
# provenance + expansion probe — 2026-11-16T05:55:26.864Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto a2e83fc2 — manifest paretocdn.site → segment paretocdn.site (CDN serving its own segments (single origin))
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 1 alive
    · hls auto 493634f3 — manifest prx-1560-ant-t.vmpx.online → segment prx-1560-ant-t.vmpx.online (relay host serving its own segments)
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto 8fa84e02 — manifest prx-1560-ant-t.vmpx.online → segment prx-1560-ant-t.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1332ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 83ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR5e9Ci0rwBHCaKoXEqSYVbU.-T-4xcvL/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 39ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 256ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 48ms rows=0 root=error formats=none hosts=none
- awsind: http=200 17ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 27ms rows=0 root=error formats=none hosts=none
- stvv: http=200 19ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 29ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_iHb-T30RF | hls@self/api/stream/v1_779wCnN-x | hls@self/api/stream/v1_BoM8Vm7gu
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_Mwaj1mzb0
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_1LuGeZGcc
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_jUOjnE2Xm
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_gzVKlAW8P
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_r3tzpcC9z | hls@self/api/stream/v1_P3-vGUZ0Y
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment late-snow-6b76.muo78n46nio4.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_YJjVx5l4f
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_I7OJ2V5sf | hls@self/api/stream/v1_hY8XQUWB8 | hls@self/api/stream/v1_inp5gAxun
    liveness: 0/4 alive (4 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_GHLZbmErn | hls@self/api/stream/v1_0LwtYglnb | hls@self/api/stream/v1_CiAYsUMDt
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_CXHKmWb74
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_bOBFsLDTe
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_98VCy_fjk
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_vwotCsIh5
    liveness: 0/1 alive (0 confirmed dead)
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_wVXQJwhFO
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_VkZF6PSy2 | hls@self/api/stream/v1_A67JQfaZR
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment gentle-pond-ab57.muo7ct1o3brm.workers.dev (edge → different segment host)
- pluto: http=200 rows=0 
- helios: http=200 rows=5 hls@self/api/stream/v1_Jl0MTx4ch | hls@self/api/stream/v1_UklIuWpMK | hls@self/api/stream/v1_TBSmsE6RU
    liveness: 1/5 alive (4 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 3 candidate(s) in 4108ms
    diag: rows=5,manifestReachable=3 flowcast=200/3 guru=200/0 primevids=200/3 citadel=200/2 quasar=timeout hindicast=timeout
    audio: hi:2 unlabelled:1
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live
- source-14 movie:693134: 0 candidate(s) in 4101ms
    diag: rows=2,manifestReachable=0 guru=200/0 primevids=200/2 citadel=timeout flowcast=timeout quasar=timeout hindicast=timeout
    audio: 
    quality: none · hosts: 
- source-14 movie:913290: 1 candidate(s) in 4103ms
    diag: rows=3,manifestReachable=1 primevids=200/3 guru=200/0 flowcast=200/2 citadel=timeout quasar=timeout hindicast=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-12 tv:1396: 4 candidate(s) in 5605ms
    diag: candidates=15,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 2 candidate(s) in 5605ms
    diag: candidates=16,reachable=2
    audio: unlabelled:2
    quality: auto · hosts: vidzen.fun
## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)
- source-1: 1 row(s), 1 alive in 938ms · gzip.rousav.tech
- source-2: 5 row(s), 5 alive in 1745ms · embed.vidrift.in,gzip.rousav.tech
- source-3: 0 row(s), 0 alive in 278ms
- source-4: 0 row(s), 0 alive in 273ms
- source-5: 0 row(s), 0 alive in 278ms
- source-7: 0 row(s), 0 alive in 247ms
- source-8: 1 row(s), 1 alive in 3232ms · img1.hscow.com
- source-9: 0 row(s), 0 alive in 503ms
- source-10: 0 row(s), 0 alive in 2923ms
- source-11: 0 row(s), 0 alive in 399ms
- source-12: 4 row(s), 4 alive in 5148ms · vidzen.fun
- source-13: 0 row(s), 0 alive in 97ms
- source-14: 1 row(s), 1 alive in 4104ms · cdn.slowcloud.live
- source-15: 0 row(s), 0 alive in 298ms
- source-16: 0 row(s), 0 alive in 0ms
- source-17: 0 row(s), 0 alive in 1ms
- source-18: 0 row(s), 0 alive in 540ms
- source-19: 0 row(s), 0 alive in 639ms
- source-20: 0 row(s), 0 alive in 206ms
- source-21: 0 row(s), 0 alive in 1489ms
- summary: 5/20 lanes produced rows for this episode from a US runner
## 6. Source 21 — Vidout catalogue, live
- tv 1396 S1E1: 1 row(s), 0 alive in 244ms · host sw5.aurorionacademy.site
- tv 1396 S1E4: 1 row(s), 0 alive in 1533ms · host sw5.aurorionacademy.site
- tv 66732 S4E1: 1 row(s), 1 alive in 185ms · host dd2stliwt0bc.homechefrecipes.sbs
    audio: hi,en · multiAudio=true
- tv 76479 S1E1: no catalogue entry (569ms)
- movie 10138: 1 row(s), 1 alive in 711ms · host wt4pjiive9agjpl.planetexploration.space
    audio: hi,ta,te,en · multiAudio=true
- movie 27205: no catalogue entry (728ms)
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

source-2   raw=4     280ms :: 2 req · vidrock.net 403 · embed.vidrift.in 200
source-10  raw=3    1188ms :: 19 req · embed.vidrift.net 200×12 · new.vidnest.fun 200×4 · new.vidnest.fun 502×2 · i-arch-400.geffe448mik.com 404
source-12  raw=3    3495ms :: 31 req · vidzen.fun 200×17 · vidzen.fun 403×12 · vidzen.fun 502 · vidzen.fun 525
source-14  raw=2    4106ms :: 10 req · scrapper.rivestream.app 200×4 · scrapper.rivestream.app timeout×2 · cdn1.slowcloud.live TypeError · img1.hscow.com 200
source-1   raw=1     554ms :: 1 req · vidbolt.xyz 200
source-20  raw=1     963ms :: 3 req · paretocdn.site 200×2 · moviesapi.to 200
source-11  raw=0     303ms :: 1 req · streamdata.vaplayer.ru 404
source-13  raw=0     135ms :: 1 req · freakyniki.elaxo.lol 403
source-15  raw=0     259ms :: 1 req · mapple.fun 200
source-16  raw=0       5ms :: 0 req
source-17  raw=0       5ms :: 0 req
source-18  raw=0     908ms :: 2 req · blakiteapi.xyz 200×2
source-19  raw=0       3ms :: 0 req
source-21  raw=0     709ms :: 2 req · cdn.jsdelivr.net 200 · suw.halcyoncreative.site TypeError
source-3   raw=0     185ms :: 2 req · vidsync.pro 200×2
source-4   raw=0     162ms :: 1 req · bingr.one 403
source-5   raw=0     282ms :: 1 req · nxsha.space 200
source-7   raw=0     239ms :: 1 req · nxsha.space 200
source-8   raw=0    3372ms :: 6 req · core.vidzee.wtf 200×2 · core.vidzee.wtf 404 · core.vidzee.wtf 400 · cdn.slowcloud.live 200
source-9   raw=0     502ms :: 2 req · vixsrc.to 200×2
```

## Source health — tv 1396 S1E1 (Breaking Bad)
```
[selftest] TMDB_API_KEY is not set: adapters that need title/year fallback will report 0.

[selftest] tv/1396: 5/20 sources returned candidates

source-2   raw=5     288ms :: 2 req · vidrock.net 403 · embed.vidrift.in 200
source-12  raw=4    5605ms :: 30 req · vidzen.fun 200×17 · vidzen.fun 403×8 · vidzen.fun timeout×4 · vidzen.fun 404
source-14  raw=3    4106ms :: 11 req · scrapper.rivestream.app 200×4 · scrapper.rivestream.app timeout×2 · img1.hscow.com 200×2 · cdn1.slowcloud.live TypeError
source-1   raw=1     219ms :: 1 req · vidbolt.xyz 200
source-8   raw=1    3279ms :: 7 req · core.vidzee.wtf 200×3 · core.vidzee.wtf 400 · img1.hscow.com 200 · cdn.slowcloud.live 200
source-10  raw=0    1656ms :: 12 req · embed.vidrift.net 404×4 · new.vidnest.fun 200×3 · new.vidnest.fun 502×3 · i-arch-400.geffe448mik.com 404×2
source-11  raw=0     326ms :: 1 req · streamdata.vaplayer.ru 404
source-13  raw=0     121ms :: 1 req · freakyniki.elaxo.lol 403
source-15  raw=0     237ms :: 1 req · mapple.fun 200
source-16  raw=0       5ms :: 0 req
source-17  raw=0       4ms :: 0 req
source-18  raw=0    1067ms :: 2 req · blakiteapi.xyz 200×2
source-19  raw=0       3ms :: 0 req
source-20  raw=0     271ms :: 1 req · moviesapi.to 404
source-21  raw=0     791ms :: 2 req · cdn.jsdelivr.net 200 · sw5.aurorionacademy.site TypeError
source-3   raw=0     194ms :: 2 req · vidsync.pro 200×2
source-4   raw=0     156ms :: 1 req · bingr.one 403
source-5   raw=0     322ms :: 1 req · nxsha.space 200
source-7   raw=0     267ms :: 1 req · nxsha.space 200
source-9   raw=0     484ms :: 2 req · vixsrc.to 200×2
```
