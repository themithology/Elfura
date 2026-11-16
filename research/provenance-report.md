# Provenance + Sources 14/12 expansion report

Run: 43816956450 on arena/4d781e96-elfura at 2026-11-16T06:31:10Z

```
# provenance + expansion probe — 2026-11-16T06:28:29.627Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto b42eabef — manifest paretocdn.site → segment paretocdn.site (CDN serving its own segments (single origin))
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 1 alive
    · hls auto 08e8a936 — manifest prx-1560-ant-t.vmpx.online → segment prx-1560-ant-t.vmpx.online (relay host serving its own segments)
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto b25acf83 — manifest prx-1560-ant-t.vmpx.online → segment prx-1560-ant-t.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1016ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 165ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR2Agivz8tnEaafwb1wSAQ8A.ANKaaprS/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 1116ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 156ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 28ms rows=0 root=error formats=none hosts=none
- awsind: http=200 32ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 16ms rows=0 root=error formats=none hosts=none
- stvv: http=200 9ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 13ms rows=0 root=error formats=none hosts=none
## 2b. Source 14 citadel language lanes (every row)
- citadel movie:579974: http=200 rows=4
    · 480p | English |  → img1.fcxmb.com/480/index_preview_266.m3u8
    · 480p | English |  → img1.fcxmb.com/480/index_preview_266.m3u8
    · 480p | English |  → img1.hscow.com/480/index_preview_287.m3u8
    · 480p | Hindi |  → img1.hscow.com/480/index_preview_287.m3u8
- citadel movie:872906: http=200 rows=6
    · 720p | Hindi |  → img1.hscow.com/720/index_287.m3u8
    · 720p | Kannada |  → img1.hscow.com/720/index_287.m3u8
    · 720p | Tamil |  → img1.fcxmb.com/Jawan_tamil1080/index_266.m3u8
    · 480p | Hindi |  → img1.hscow.com/480/index_287.m3u8
    · 480p | Kannada |  → img1.fcxmb.com/480/index_266.m3u8
    · 480p | Telugu |  → img1.hscow.com/480/index_287.m3u8
- citadel movie:693134: http=200 rows=10
    · 720p | English |  → img1.fcxmb.com/720/index_266.m3u8
    · 720p | Hindi |  → img1.fcxmb.com/Hindi_720/index_266.m3u8
    · 720p | Kannada |  → img1.hscow.com/Kan_720/index_287.m3u8
    · 720p | Tamil |  → img1.hscow.com/Tamil_720/index_287.m3u8
    · 720p | Telugu |  → img1.fcxmb.com/Tel_720/index_266.m3u8
    · 480p | English |  → img1.hscow.com/480/index_287.m3u8
    · 480p | Hindi |  → img1.fcxmb.com/Hindi_480/index_266.m3u8
    · 480p | Kannada |  → img1.fcxmb.com/Kan_480/index_266.m3u8
    · 480p | Tamil |  → img1.fcxmb.com/Tamil_480/index_266.m3u8
    · 480p | Telugu |  → img1.fcxmb.com/Tel_480/index_266.m3u8
- citadel tv:1396: http=200 rows=2
    · 720p | Hindi |  → img1.hscow.com/720/index_287.m3u8
    · 480p | Hindi |  → img1.hscow.com/480/index_287.m3u8


## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_omPJLJzOp | hls@self/api/stream/v1_GkMMvi5Pb | hls@self/api/stream/v1_r_MkqvBTT
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_UKCcTD_Pf
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_EM9Sulo-N
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_gnxKh0nP9
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_yfQE4KqO9
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_LPC1WjBs9 | hls@self/api/stream/v1_aSMUsXWk9
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment dark-grass-3324.muo7rayr01nj.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_8zXQhj9QT
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_kbSi0ZfDd | hls@self/api/stream/v1_G5FQIG39x | hls@self/api/stream/v1_VAcKiYdx1
    liveness: 0/4 alive (4 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_VFZARm8JH | hls@self/api/stream/v1___LJ6hzwl | hls@self/api/stream/v1_3HUjEjoUC
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_BGe67Bec3
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_4xRurAqRE
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_ltOSKTYPg
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_XGJhaAYQ-
    liveness: 0/1 alive (0 confirmed dead)
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_uqWxX2d64
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_N0Tv-W57T | hls@self/api/stream/v1_GaBmqd3dZ
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment rapid-feather-11de.mue2rxjlgdcr.workers.dev (edge → different segment host)
- pluto: http=200 rows=0 
- helios: http=200 rows=5 hls@self/api/stream/v1_s9n6hPlHh | hls@self/api/stream/v1_yjI2jS5Af | hls@self/api/stream/v1_UI3Mj7Sb_
    liveness: 1/5 alive (4 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 2 candidate(s) in 4106ms
    diag: rows=4,manifestReachable=2 flowcast=200/3 guru=200/0 primevids=200/3 citadel=200/3 quasar=timeout hindicast=timeout
    audio: hi:1 unlabelled:1
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live
- source-14 movie:693134: 10 candidate(s) in 4108ms
    diag: rows=12,manifestReachable=10 guru=200/0 primevids=200/2 citadel=200/10 flowcast=timeout quasar=timeout hindicast=timeout
    audio: en:2 hi:2 kn:2 ta:2 te:2
    quality: auto · hosts: img1.fcxmb.com,img1.hscow.com
- source-14 movie:913290: 1 candidate(s) in 4102ms
    diag: rows=3,manifestReachable=1 primevids=200/3 guru=200/0 citadel=timeout flowcast=timeout quasar=timeout hindicast=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-12 tv:1396: 4 candidate(s) in 5603ms
    diag: candidates=15,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 2 candidate(s) in 5607ms
    diag: candidates=16,reachable=2
    audio: unlabelled:2
    quality: auto · hosts: vidzen.fun
## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)
- source-1: 1 row(s), 1 alive in 1039ms · gzip.rousav.tech
- source-2: 8 row(s), 5 alive in 1690ms · embed.vidrift.in,mb.vidrift.net,gzip.rousav.tech
- source-3: 0 row(s), 0 alive in 155ms
- source-4: 0 row(s), 0 alive in 84ms
- source-5: 0 row(s), 0 alive in 224ms
- source-7: 0 row(s), 0 alive in 206ms
- source-8: 1 row(s), 1 alive in 3500ms · img1.hscow.com
- source-9: 0 row(s), 0 alive in 720ms
- source-10: 0 row(s), 0 alive in 2056ms
- source-11: 0 row(s), 0 alive in 441ms
- source-12: 4 row(s), 4 alive in 4905ms · vidzen.fun
- source-13: 0 row(s), 0 alive in 52ms
- source-14: 3 row(s), 3 alive in 4102ms · img1.hscow.com,cdn.slowcloud.live
- source-15: 0 row(s), 0 alive in 371ms
- source-16: 0 row(s), 0 alive in 0ms
- source-17: 0 row(s), 0 alive in 1ms
- source-18: 0 row(s), 0 alive in 611ms
- source-19: 0 row(s), 0 alive in 311ms
- source-20: 0 row(s), 0 alive in 241ms
- source-21: 0 row(s), 0 alive in 1213ms
- summary: 5/20 lanes produced rows for this episode from a US runner
## 6. Source 21 — Vidout catalogue, live
- tv 1396 S1E1: 1 row(s), 0 alive in 916ms · host sw5.aurorionacademy.site
- tv 1396 S1E4: 1 row(s), 0 alive in 1416ms · host sw5.aurorionacademy.site
- tv 66732 S4E1: 1 row(s), 1 alive in 1541ms · host dd2stliwt0bc.homechefrecipes.sbs
    audio: hi,en · multiAudio=true
- tv 76479 S1E1: no catalogue entry (478ms)
- movie 10138: 1 row(s), 1 alive in 1155ms · host wt4pjiive9agjpl.planetexploration.space
    audio: hi,ta,te,en · multiAudio=true
- movie 27205: no catalogue entry (1604ms)
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

source-2   raw=4     298ms :: 2 req · vidrock.net 403 · embed.vidrift.in 200
source-10  raw=3    1259ms :: 19 req · embed.vidrift.net 200×12 · new.vidnest.fun 200×4 · new.vidnest.fun 502×2 · i-arch-400.geffe448mik.com 404
source-12  raw=3    4396ms :: 31 req · vidzen.fun 200×17 · vidzen.fun 403×12 · vidzen.fun 525 · vidzen.fun timeout
source-14  raw=2    4106ms :: 10 req · scrapper.rivestream.app 200×3 · scrapper.rivestream.app timeout×3 · cdn1.slowcloud.live TypeError · img1.hscow.com 200
source-1   raw=1     569ms :: 1 req · vidbolt.xyz 200
source-20  raw=1    1273ms :: 3 req · paretocdn.site 200×2 · moviesapi.to 200
source-11  raw=0     326ms :: 1 req · streamdata.vaplayer.ru 404
source-13  raw=0     113ms :: 1 req · freakyniki.elaxo.lol 403
source-15  raw=0     304ms :: 1 req · mapple.fun 200
source-16  raw=0       5ms :: 0 req
source-17  raw=0       4ms :: 0 req
source-18  raw=0    1239ms :: 2 req · blakiteapi.xyz 200×2
source-19  raw=0       3ms :: 0 req
source-21  raw=0     432ms :: 2 req · cdn.jsdelivr.net 200 · suw.halcyoncreative.site TypeError
source-3   raw=0     343ms :: 2 req · vidsync.pro 200×2
source-4   raw=0     140ms :: 1 req · bingr.one 403
source-5   raw=0     251ms :: 1 req · nxsha.space 200
source-7   raw=0     293ms :: 1 req · nxsha.space 200
source-8   raw=0    3279ms :: 6 req · core.vidzee.wtf 200×2 · core.vidzee.wtf 400 · core.vidzee.wtf 404 · cdn.slowcloud.live 200
source-9   raw=0     548ms :: 2 req · vixsrc.to 200×2
```

## Source health — tv 1396 S1E1 (Breaking Bad)
```
[selftest] TMDB_API_KEY is not set: adapters that need title/year fallback will report 0.

[selftest] tv/1396: 5/20 sources returned candidates

source-2   raw=5     272ms :: 2 req · vidrock.net 403 · embed.vidrift.in 200
source-12  raw=4    4519ms :: 30 req · vidzen.fun 200×19 · vidzen.fun 403×8 · vidzen.fun 404 · vidzen.fun 502
source-14  raw=3    4107ms :: 11 req · scrapper.rivestream.app 200×4 · scrapper.rivestream.app timeout×2 · img1.hscow.com 200×2 · cdn1.slowcloud.live TypeError
source-1   raw=1     233ms :: 1 req · vidbolt.xyz 200
source-8   raw=1    3312ms :: 7 req · core.vidzee.wtf 200×3 · core.vidzee.wtf 400 · img1.hscow.com 200 · cdn.slowcloud.live 200
source-10  raw=0    1649ms :: 12 req · embed.vidrift.net 404×4 · new.vidnest.fun 200×3 · new.vidnest.fun 502×3 · i-arch-400.geffe448mik.com 404×2
source-11  raw=0     328ms :: 1 req · streamdata.vaplayer.ru 404
source-13  raw=0     131ms :: 1 req · freakyniki.elaxo.lol 403
source-15  raw=0     339ms :: 1 req · mapple.fun 200
source-16  raw=0       5ms :: 0 req
source-17  raw=0       4ms :: 0 req
source-18  raw=0    1273ms :: 2 req · blakiteapi.xyz 200×2
source-19  raw=0       3ms :: 0 req
source-20  raw=0     322ms :: 1 req · moviesapi.to 404
source-21  raw=0     625ms :: 2 req · cdn.jsdelivr.net 200 · sw5.aurorionacademy.site TypeError
source-3   raw=0     203ms :: 2 req · vidsync.pro 200×2
source-4   raw=0     158ms :: 1 req · bingr.one 403
source-5   raw=0     262ms :: 1 req · nxsha.space 200
source-7   raw=0     272ms :: 1 req · nxsha.space 200
source-9   raw=0     510ms :: 2 req · vixsrc.to 200×2
```
