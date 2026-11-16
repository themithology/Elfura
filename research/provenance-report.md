# Provenance + Sources 14/12 expansion report

Run: 43746511423 on arena/399224d8-elfura at 2026-11-15T18:25:55Z

```
# provenance + expansion probe — 2026-11-15T18:23:50.628Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto 2de97d58 — manifest patient-cherry.workerscloud32.workers.dev → segment patient-cherry.workerscloud32.workers.dev (relay host serving its own segments)
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 0 row(s), 0 alive
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto a72a769b — manifest prx-1331-ant-q.vmpx.online → segment prx-1331-ant-q.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 607ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 90ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR9WKyqpq5fFjiDiRVf7RRKI.N1d1c-fO/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 948ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: http=200 4909ms rows=0 root=data formats=none hosts=none
- guru: http=200 270ms rows=0 root=data formats=none hosts=none
- hindicast: http=200 1374ms rows=0 root=data formats=none hosts=none
- mhbox: http=200 20ms rows=0 root=error formats=none hosts=none
- awsind: http=200 32ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 16ms rows=0 root=error formats=none hosts=none
- stvv: http=200 29ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 27ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_cq7hy6pIh | hls@self/api/stream/v1_ijg8FcEZJ | hls@self/api/stream/v1_8SUnBIdHQ
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_iQpj2-y2j
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_exepddCC3
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_Z4QBVh9k4
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=0 
- uranus: http=200 rows=2 hls@self/api/stream/v1_lBolFA5Bu | hls@self/api/stream/v1_dI_b0W4YS
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment late-snow-6b76.muo78n46nio4.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_jI9-6l08e
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_AvM_TdKzy | hls@self/api/stream/v1_UBPeSzV0E | hls@self/api/stream/v1_b0plxD82b
    liveness: 0/4 alive (4 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_C8VvnY9wP | hls@self/api/stream/v1_ryVY0yAm7 | hls@self/api/stream/v1_fPBSJkd5G
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_tkHpRBbM9
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_7tm_8yxkX
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_S-ifN8Yhz
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_8vxURfZhG
    liveness: 0/1 alive (0 confirmed dead)
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_j3ajHerRN
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_cSY8Rbvfs | hls@self/api/stream/v1_-Lol6zwDA
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen4.mu9x4dl4kp7j.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_OwZo6n9Y3
    liveness: 0/1 alive (1 confirmed dead)
- helios: http=200 rows=5 hls@self/api/stream/v1_4wQjfyfU1 | hls@self/api/stream/v1_dQ<n>U8UD | hls@self/api/stream/v1_W_r7GOjpt
    liveness: 0/5 alive (4 confirmed dead)

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 3 candidate(s) in 4105ms
    diag: rows=5,manifestReachable=3 flowcast=200/3 guru=200/0 primevids=200/3 citadel=200/2 quasar=timeout hindicast=timeout
    audio: hi:2 unlabelled:1
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live
- source-14 movie:693134: 0 candidate(s) in 4101ms
    diag: rows=2,manifestReachable=0 primevids=200/2 guru=200/0 hindicast=200/0 citadel=timeout flowcast=timeout quasar=timeout
    audio: 
    quality: none · hosts: 
- source-14 movie:913290: 1 candidate(s) in 4102ms
    diag: rows=3,manifestReachable=1 primevids=200/3 guru=200/0 hindicast=200/0 flowcast=200/2 citadel=timeout quasar=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-12 tv:1396: 4 candidate(s) in 3491ms
    diag: candidates=14,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 3 candidate(s) in 3661ms
    diag: candidates=17,reachable=3
    audio: unlabelled:3
    quality: auto · hosts: vidzen.fun
## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)
- source-1: 1 row(s), 1 alive in 1026ms · gzip.rousav.tech
- source-2: 5 row(s), 5 alive in 1573ms · embed.vidrift.in,gzip.rousav.tech
- source-3: 0 row(s), 0 alive in 364ms
- source-4: 0 row(s), 0 alive in 584ms
- source-5: 0 row(s), 0 alive in 292ms
- source-7: 0 row(s), 0 alive in 230ms
- source-8: 1 row(s), 1 alive in 3409ms · img1.hscow.com
- source-9: 0 row(s), 0 alive in 478ms
- source-10: 0 row(s), 0 alive in 1617ms
- source-11: 0 row(s), 0 alive in 360ms
- source-12: 4 row(s), 4 alive in 5152ms · vidzen.fun
- source-13: 0 row(s), 0 alive in 133ms
- source-14: 3 row(s), 3 alive in 4103ms · img1.hscow.com,cdn.slowcloud.live
- source-15: 0 row(s), 0 alive in 303ms
- source-16: 0 row(s), 0 alive in 0ms
- source-17: 0 row(s), 0 alive in 1ms
- source-18: 0 row(s), 0 alive in 559ms
- source-19: 0 row(s), 0 alive in 6419ms
- source-20: 0 row(s), 0 alive in 475ms
- source-21: 0 row(s), 0 alive in 477ms
- summary: 5/20 lanes produced rows for this episode from a US runner
## 6. Source 21 — Vidout catalogue, live
- tv 1396 S1E1: 1 row(s), 0 alive in 692ms · host sw5.aurorionacademy.site
- tv 1396 S1E4: 1 row(s), 0 alive in 1937ms · host sw5.aurorionacademy.site
- tv 66732 S4E1: 1 row(s), 1 alive in 534ms · host dd2stliwt0bc.homechefrecipes.sbs
    audio: hi,en · multiAudio=true
- tv 76479 S1E1: no catalogue entry (683ms)
- movie 10138: 1 row(s), 1 alive in 293ms · host wt4pjiive9agjpl.planetexploration.space
    audio: hi,ta,te,en · multiAudio=true
- movie 27205: no catalogue entry (609ms)
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

source-2   raw=4     340ms :: 2 req · vidrock.net 403 · embed.vidrift.in 200
source-12  raw=3    4295ms :: 31 req · vidzen.fun 200×17 · vidzen.fun 403×12 · vidzen.fun 525 · vidzen.fun 502
source-1   raw=1     257ms :: 1 req · vidbolt.xyz 200
source-14  raw=1    4102ms :: 9 req · scrapper.rivestream.app 200×4 · scrapper.rivestream.app timeout×2 · cdn1.slowcloud.live TypeError · cdn.slowcloud.live 200
source-20  raw=1    1490ms :: 3 req · paretocdn.site 200×2 · moviesapi.to 200
source-10  raw=0    1119ms :: 11 req · embed.vidrift.net 404×4 · new.vidnest.fun 200×3 · new.vidnest.fun 502×3 · i-arch-400.geffe448mik.com 404
source-11  raw=0     429ms :: 1 req · streamdata.vaplayer.ru 404
source-13  raw=0     117ms :: 1 req · freakyniki.elaxo.lol 403
source-15  raw=0     219ms :: 1 req · mapple.fun 200
source-16  raw=0       4ms :: 0 req
source-17  raw=0       3ms :: 0 req
source-18  raw=0    1093ms :: 2 req · blakiteapi.xyz 200×2
source-19  raw=0       3ms :: 0 req
source-21  raw=0    1221ms :: 2 req · cdn.jsdelivr.net 200 · suw.halcyoncreative.site TypeError
source-3   raw=0     228ms :: 2 req · vidsync.pro 200×2
source-4   raw=0     116ms :: 1 req · bingr.one 403
source-5   raw=0     451ms :: 1 req · nxsha.space 200
source-7   raw=0     327ms :: 1 req · nxsha.space 200
source-8   raw=0    3241ms :: 6 req · core.vidzee.wtf 200×2 · core.vidzee.wtf 400 · core.vidzee.wtf 404 · cdn.slowcloud.live 200
source-9   raw=0     480ms :: 2 req · vixsrc.to 200×2
```

## Source health — tv 1396 S1E1 (Breaking Bad)
```
[selftest] TMDB_API_KEY is not set: adapters that need title/year fallback will report 0.

[selftest] tv/1396: 5/20 sources returned candidates

source-2   raw=5     260ms :: 2 req · vidrock.net 403 · embed.vidrift.in 200
source-12  raw=4    4271ms :: 29 req · vidzen.fun 200×19 · vidzen.fun 403×8 · vidzen.fun 404 · vidzen.fun 525
source-1   raw=1     557ms :: 1 req · vidbolt.xyz 200
source-14  raw=1    4103ms :: 9 req · scrapper.rivestream.app 200×3 · scrapper.rivestream.app timeout×3 · cdn1.slowcloud.live TypeError · cdn.slowcloud.live 200
source-8   raw=1    3338ms :: 7 req · core.vidzee.wtf 200×3 · core.vidzee.wtf 400 · img1.hscow.com 200 · cdn.slowcloud.live 200
source-10  raw=0    2376ms :: 12 req · new.vidnest.fun 502×4 · embed.vidrift.net 404×4 · new.vidnest.fun 200×2 · i-arch-400.geffe448mik.com 404×2
source-11  raw=0     283ms :: 1 req · streamdata.vaplayer.ru 404
source-13  raw=0     103ms :: 1 req · freakyniki.elaxo.lol 403
source-15  raw=0     273ms :: 1 req · mapple.fun 200
source-16  raw=0       4ms :: 0 req
source-17  raw=0       3ms :: 0 req
source-18  raw=0    1106ms :: 2 req · blakiteapi.xyz 200×2
source-19  raw=0       2ms :: 0 req
source-20  raw=0     273ms :: 1 req · moviesapi.to 404
source-21  raw=0    1423ms :: 2 req · cdn.jsdelivr.net 200 · sw5.aurorionacademy.site TypeError
source-3   raw=0     142ms :: 2 req · vidsync.pro 200×2
source-4   raw=0     115ms :: 1 req · bingr.one 403
source-5   raw=0     299ms :: 1 req · nxsha.space 200
source-7   raw=0     237ms :: 1 req · nxsha.space 200
source-9   raw=0     482ms :: 2 req · vixsrc.to 200×2
```
