# Provenance + Sources 14/12 expansion report

Run: 43816140586 on arena/4d781e96-elfura at 2026-11-16T06:23:54Z

```
# provenance + expansion probe — 2026-11-16T06:21:11.791Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto 4caa0f6a — manifest patient-cherry.workerscloud32.workers.dev → segment patient-cherry.workerscloud32.workers.dev (relay host serving its own segments)
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 1 alive
    · hls auto 518c127c — manifest prx-1560-ant-t.vmpx.online → segment prx-1560-ant-t.vmpx.online (relay host serving its own segments)
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto 9ff92ae7 — manifest prx-1560-ant-t.vmpx.online → segment prx-1560-ant-t.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1259ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 135ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR34QMtDODzSPIp4uV55MqVY.VCcaS4z-/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 1208ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 140ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 63ms rows=0 root=error formats=none hosts=none
- awsind: http=200 211ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 35ms rows=0 root=error formats=none hosts=none
- stvv: http=200 57ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 26ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_3i30eAZZH | hls@self/api/stream/v1_4cI9I96ao | hls@self/api/stream/v1_pwa2Y2iNF
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_uRE8mLIgv
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_aPIASkOiO
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_W8Nqo7NBY
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_A53AtX7pU
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_Z8VTpXnYH | hls@self/api/stream/v1_I5rLru4Eb
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment falling-pine-39a4.xdbypass.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_HgQyBTwm9
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_taN4sSAUp | hls@self/api/stream/v1_dqikgbHAR | hls@self/api/stream/v1_EuXM3_PnE
    liveness: 0/4 alive (4 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_EwEmlY7mh | hls@self/api/stream/v1_d1z3S1S19 | hls@self/api/stream/v1_cPUuKedEP
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_r6gmjd5qg
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_xx8ktflBb
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_7t4IIlJsX
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_YsouSiJ97
    liveness: 0/1 alive (0 confirmed dead)
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1__5G-2N-vY
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_nWtaS3wtD | hls@self/api/stream/v1_f5Mmfbk8j
    liveness: 0/2 alive (0 confirmed dead)
- pluto: error TimeoutError
- helios: http=200 rows=5 hls@self/api/stream/v1_Dbc0Ie5_9 | hls@self/api/stream/v1_gI0s6SUuK | hls@self/api/stream/v1_CbnC_9GS6
    liveness: 1/5 alive (4 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 3 candidate(s) in 4106ms
    diag: rows=5,manifestReachable=3 flowcast=200/3 guru=200/0 primevids=200/3 citadel=200/2 quasar=timeout hindicast=timeout
    audio: hi:2 unlabelled:1
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live
- source-14 movie:693134: 0 candidate(s) in 4102ms
    diag: rows=2,manifestReachable=0 primevids=200/2 guru=200/0 citadel=timeout flowcast=timeout quasar=timeout hindicast=timeout
    audio: 
    quality: none · hosts: 
- source-14 movie:913290: 1 candidate(s) in 4102ms
    diag: rows=3,manifestReachable=1 primevids=200/3 guru=200/0 flowcast=200/2 citadel=timeout quasar=timeout hindicast=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-12 tv:1396: 4 candidate(s) in 5061ms
    diag: candidates=15,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 0 candidate(s) in 2601ms
    diag: candidates=0,reachable=0
    audio: 
    quality: none · hosts: 
## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)
- source-1: 1 row(s), 1 alive in 1516ms · gzip.rousav.tech
- source-2: 8 row(s), 5 alive in 2782ms · embed.vidrift.in,mb.vidrift.net,gzip.rousav.tech
- source-3: 0 row(s), 0 alive in 179ms
- source-4: 0 row(s), 0 alive in 141ms
- source-5: 0 row(s), 0 alive in 264ms
- source-7: 0 row(s), 0 alive in 257ms
- source-8: 1 row(s), 1 alive in 3843ms · img1.hscow.com
- source-9: 0 row(s), 0 alive in 1094ms
- source-10: 0 row(s), 0 alive in 1818ms
- source-11: 0 row(s), 0 alive in 410ms
- source-12: 0 row(s), 0 alive in 8208ms
- source-13: 0 row(s), 0 alive in 89ms
- source-14: 3 row(s), 3 alive in 4104ms · img1.hscow.com,cdn.slowcloud.live
- source-15: 0 row(s), 0 alive in 524ms
- source-16: 0 row(s), 0 alive in 0ms
- source-17: 0 row(s), 0 alive in 1ms
- source-18: 0 row(s), 0 alive in 656ms
- source-19: 0 row(s), 0 alive in 650ms
- source-20: 0 row(s), 0 alive in 270ms
- source-21: 0 row(s), 0 alive in 1308ms
- summary: 4/20 lanes produced rows for this episode from a US runner
## 6. Source 21 — Vidout catalogue, live
- tv 1396 S1E1: 1 row(s), 0 alive in 530ms · host sw5.aurorionacademy.site
- tv 1396 S1E4: 1 row(s), 0 alive in 247ms · host sw5.aurorionacademy.site
- tv 66732 S4E1: 1 row(s), 1 alive in 1531ms · host dd2stliwt0bc.homechefrecipes.sbs
    audio: hi,en · multiAudio=true
- tv 76479 S1E1: no catalogue entry (588ms)
- movie 10138: 1 row(s), 1 alive in 313ms · host wt4pjiive9agjpl.planetexploration.space
    audio: hi,ta,te,en · multiAudio=true
- movie 27205: no catalogue entry (808ms)
## 7. Source 21 transport checks (status codes only)
- tv host plain: 0  TypeError:ECONNRESET
- tv host referred: 0  TypeError:ECONNRESET
- movie host plain: 404 text/html <html>\n<head><title>404 Not Found</titl
- movie host referred: 200 application/vnd.apple.mpegurl #EXTM3U\n\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-I
```

## Source health — movie 550 (Fight Club)
```
[selftest] TMDB_API_KEY is not set: adapters that need title/year fallback will report 0.

[selftest] movie/550: 5/20 sources returned candidates

source-2   raw=8     305ms :: 2 req · vidrock.net 403 · embed.vidrift.in 200
source-10  raw=3    1381ms :: 19 req · embed.vidrift.net 200×12 · new.vidnest.fun 200×4 · new.vidnest.fun 502×2 · i-arch-400.geffe448mik.com 404
source-14  raw=2    4106ms :: 10 req · scrapper.rivestream.app 200×3 · scrapper.rivestream.app timeout×3 · cdn1.slowcloud.live TypeError · img1.hscow.com 200
source-1   raw=1     347ms :: 1 req · vidbolt.xyz 200
source-20  raw=1    1190ms :: 3 req · paretocdn.site 200×2 · moviesapi.to 200
source-11  raw=0     445ms :: 1 req · streamdata.vaplayer.ru 404
source-12  raw=0    2602ms :: 1 req · vidzen.fun timeout
source-13  raw=0      85ms :: 1 req · freakyniki.elaxo.lol 403
source-15  raw=0     317ms :: 1 req · mapple.fun 200
source-16  raw=0       5ms :: 0 req
source-17  raw=0       4ms :: 0 req
source-18  raw=0    1185ms :: 2 req · blakiteapi.xyz 200×2
source-19  raw=0       2ms :: 0 req
source-21  raw=0    1308ms :: 2 req · cdn.jsdelivr.net 200 · suw.halcyoncreative.site TypeError
source-3   raw=0     185ms :: 2 req · vidsync.pro 200×2
source-4   raw=0     150ms :: 1 req · bingr.one 403
source-5   raw=0     367ms :: 1 req · nxsha.space 200
source-7   raw=0     279ms :: 1 req · nxsha.space 200
source-8   raw=0    3332ms :: 6 req · core.vidzee.wtf 200×2 · core.vidzee.wtf 400 · core.vidzee.wtf 404 · cdn.slowcloud.live 200
source-9   raw=0     578ms :: 2 req · vixsrc.to 200×2
```

## Source health — tv 1396 S1E1 (Breaking Bad)
```
[selftest] TMDB_API_KEY is not set: adapters that need title/year fallback will report 0.

[selftest] tv/1396: 5/20 sources returned candidates

source-2   raw=8     429ms :: 2 req · vidrock.net 403 · embed.vidrift.in 200
source-12  raw=4    5607ms :: 30 req · vidzen.fun 200×17 · vidzen.fun 403×7 · vidzen.fun timeout×4 · vidzen.fun 404
source-14  raw=3    4107ms :: 11 req · scrapper.rivestream.app 200×4 · scrapper.rivestream.app timeout×2 · img1.hscow.com 200×2 · cdn.slowcloud.live 200
source-1   raw=1     228ms :: 1 req · vidbolt.xyz 200
source-8   raw=1    3313ms :: 7 req · core.vidzee.wtf 200×3 · core.vidzee.wtf 400 · img1.hscow.com 200 · cdn.slowcloud.live 200
source-10  raw=0    2235ms :: 12 req · embed.vidrift.net 404×4 · new.vidnest.fun 200×3 · new.vidnest.fun 502×3 · i-arch-400.geffe448mik.com 404×2
source-11  raw=0     356ms :: 1 req · streamdata.vaplayer.ru 404
source-13  raw=0     143ms :: 1 req · freakyniki.elaxo.lol 403
source-15  raw=0     349ms :: 1 req · mapple.fun 200
source-16  raw=0       6ms :: 0 req
source-17  raw=0       5ms :: 0 req
source-18  raw=0    1160ms :: 2 req · blakiteapi.xyz 200×2
source-19  raw=0       4ms :: 0 req
source-20  raw=0     375ms :: 1 req · moviesapi.to 404
source-21  raw=0    1426ms :: 2 req · cdn.jsdelivr.net 200 · sw5.aurorionacademy.site TypeError
source-3   raw=0     204ms :: 2 req · vidsync.pro 200×2
source-4   raw=0     164ms :: 1 req · bingr.one 403
source-5   raw=0     291ms :: 1 req · nxsha.space 200
source-7   raw=0     361ms :: 1 req · nxsha.space 200
source-9   raw=0     537ms :: 2 req · vixsrc.to 200×2
```
