# Provenance + Sources 14/12 expansion report

Run: 43819193619 on arena/4d781e96-elfura at 2026-11-16T06:50:09Z

```
# provenance + expansion probe — 2026-11-16T06:47:35.811Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto 3df1731a — manifest patient-cherry.workerscloud32.workers.dev → segment patient-cherry.workerscloud32.workers.dev (relay host serving its own segments)
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 1 alive
    · hls auto 7e578b83 — manifest prx-1560-ant-t.vmpx.online → segment prx-1560-ant-t.vmpx.online (relay host serving its own segments)
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto 529c4bfb — manifest prx-1560-ant-t.vmpx.online → segment prx-1560-ant-t.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1404ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 103ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR7h8ZyDlDG8BTbbenn7nB9o.4yLgnZJB/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 847ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 474ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 44ms rows=0 root=error formats=none hosts=none
- awsind: http=200 98ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 21ms rows=0 root=error formats=none hosts=none
- stvv: http=200 11ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 39ms rows=0 root=error formats=none hosts=none
## 2b. Source 14 citadel language lanes (every row)
- citadel movie:579974: http=200 rows=4
    · 480p | English |  → img1.fcxmb.com/480/index_preview_266.m3u8
    · 480p | Hindi |  → img1.hscow.com/480/index_preview_287.m3u8
    · 480p | Tamil |  → img1.hscow.com/480/index_preview_287.m3u8
    · 480p | Telugu |  → img1.fcxmb.com/480/index_preview_266.m3u8
- citadel movie:872906: http=200 rows=6
    · 720p | Hindi |  → img1.hscow.com/720/index_287.m3u8
    · 720p | Kannada |  → img1.hscow.com/720/index_287.m3u8
    · 720p | Tamil |  → img1.fcxmb.com/Jawan_tamil1080/index_266.m3u8
    · 480p | Hindi |  → img1.fcxmb.com/480/index_266.m3u8
    · 480p | Kannada |  → img1.fcxmb.com/480/index_266.m3u8
    · 480p | Telugu |  → img1.hscow.com/480/index_287.m3u8
- citadel movie:693134: http=200 rows=10
    · 720p | English |  → img1.hscow.com/720/index_287.m3u8
    · 720p | Hindi |  → img1.hscow.com/Hindi_720/index_287.m3u8
    · 720p | Kannada |  → img1.hscow.com/Kan_720/index_287.m3u8
    · 720p | Tamil |  → img1.fcxmb.com/Tamil_720/index_266.m3u8
    · 720p | Telugu |  → img1.fcxmb.com/Tel_720/index_266.m3u8
    · 480p | English |  → img1.hscow.com/480/index_287.m3u8
    · 480p | Hindi |  → img1.fcxmb.com/Hindi_480/index_266.m3u8
    · 480p | Kannada |  → img1.fcxmb.com/Kan_480/index_266.m3u8
    · 480p | Tamil |  → img1.fcxmb.com/Tamil_480/index_266.m3u8
    · 480p | Telugu |  → img1.fcxmb.com/Tel_480/index_266.m3u8
- citadel tv:1396: http=200 rows=2
    · 720p | Hindi |  → img1.hscow.com/720/index_287.m3u8
    · 480p | Hindi |  → img1.hscow.com/480/index_287.m3u8


## 2c. Shared-URL citadel rows — one file with several audio tracks?
- movie:872906: 6 row(s) in 6 distinct url(s)
    · img1.fcxmb.com/720/index_266.m3u8 [720p Hindi]: http=200 variants=0 audioRenditions=0
    · img1.hscow.com/720/index_287.m3u8 [720p Kannada]: http=200 variants=0 audioRenditions=0
    · img1.hscow.com/Jawan_tamil1080/index_287.m3u8 [720p Tamil]: http=200 variants=0 audioRenditions=0
    · img1.fcxmb.com/480/index_266.m3u8 [480p Hindi]: http=200 variants=0 audioRenditions=0
- movie:693134: 10 row(s) in 10 distinct url(s)
    · img1.hscow.com/720/index_287.m3u8 [720p English]: http=200 variants=0 audioRenditions=0
    · img1.hscow.com/Hindi_720/index_287.m3u8 [720p Hindi]: http=200 variants=0 audioRenditions=0
    · img1.fcxmb.com/Kan_720/index_266.m3u8 [720p Kannada]: http=200 variants=0 audioRenditions=0
    · img1.fcxmb.com/Tamil_720/index_266.m3u8 [720p Tamil]: http=200 variants=0 audioRenditions=0
- tv:1396: 3 row(s) in 3 distinct url(s)
    · img1.hscow.com/720/index_287.m3u8 [720p Hindi]: http=200 variants=0 audioRenditions=0
    · img1.hscow.com/480/index_287.m3u8 [480p English]: http=200 variants=0 audioRenditions=0
    · img1.hscow.com/480/index_287.m3u8 [480p Hindi]: http=200 variants=0 audioRenditions=0

## 2d. Same citadel path, different language labels — same bytes or not?
- movie:872906: 0 path(s) carrying more than one label
- movie:693134: 0 path(s) carrying more than one label

## 2e. What a citadel row actually contains
- movie:872906: 6 row(s); top keys: sources,captions
    row keys: quality,url,source,format
    row: {"quality":"720p | Hindi","url":"img1.hscow.com/720/index_287.m3u8","source":"Citadel","format":"hls"}
    rows with a language field: 0/6
- movie:693134: 10 row(s); top keys: sources,captions
    row keys: quality,url,source,format
    row: {"quality":"720p | English","url":"img1.hscow.com/720/index_287.m3u8","source":"Citadel","format":"hls"}
    rows with a language field: 0/10

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_JN_nksIkW | hls@self/api/stream/v1_CGLkVDbFg | hls@self/api/stream/v1_eCNvcE42z
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_Sxj4hitA6
    liveness: 0/1 alive (0 confirmed dead)
- jupiter: http=200 rows=1 hls@self/api/stream/v1_gSBlj3joU
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_iaFtpf5mi
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_VfuQqM_nO
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_qpQ-ewCZC | hls@self/api/stream/v1_0Tn7hwWXC
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment summer-rice-bcb5.mviekv8xbime.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_VEUYI19dE
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_dzwjh68sh | hls@self/api/stream/v1_DN7khkn9q | hls@self/api/stream/v1_wVwCxxaak
    liveness: 0/4 alive (4 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_OcsHA09YD | hls@self/api/stream/v1_LDkzvuf6H | hls@self/api/stream/v1_-BK5kwGWY
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_x4MitflNT
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_R5XFtwlIL
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_bddYesPMX
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_ejtKwv1iu
    liveness: 0/1 alive (0 confirmed dead)
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_FQgLSD7mZ
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_EwuCxi4Ll | hls@self/api/stream/v1_jutOo93Xc
    liveness: 0/2 alive (0 confirmed dead)
- pluto: http=200 rows=0 
- helios: http=200 rows=5 hls@self/api/stream/v1_joQYqDHY6 | hls@self/api/stream/v1_AjJbQoOm0 | hls@self/api/stream/v1_oU-rjN8bJ
    liveness: 1/5 alive (4 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 3 candidate(s) in 4105ms
    diag: rows=5,manifestReachable=3 guru=200/0 flowcast=200/3 primevids=200/3 citadel=200/2 quasar=timeout hindicast=timeout
    audio: hi:2 unlabelled:1
    labels: Hindi, Hindi, —
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live
- source-14 movie:693134: 10 candidate(s) in 4109ms
    diag: rows=12,manifestReachable=10 primevids=200/2 guru=200/0 citadel=200/10 flowcast=timeout quasar=timeout hindicast=timeout
    audio: en:2 hi:2 kn:2 ta:2 te:2
    labels: English, Hindi, Kannada, Tamil, Telugu, English, Hindi, Kannada, Tamil, Telugu
    quality: auto · hosts: img1.fcxmb.com,img1.hscow.com
- source-14 movie:913290: 1 candidate(s) in 4103ms
    diag: rows=3,manifestReachable=1 primevids=200/3 guru=200/0 flowcast=200/2 citadel=timeout quasar=timeout hindicast=timeout
    audio: unlabelled:1
    labels: —
    quality: auto · hosts: cdn.slowcloud.live
- source-14 movie:872906: 5 candidate(s) in 4106ms
    diag: rows=6,manifestReachable=5 primevids=200/1 guru=200/0 flowcast=200/1 citadel=200/6 quasar=timeout hindicast=timeout
    audio: hi:2 ta:1 kn:1 te:1
    labels: Hindi, Tamil, Hindi, Kannada, Telugu
    quality: auto · hosts: img1.hscow.com,img1.fcxmb.com
- source-14 movie:579974: 3 candidate(s) in 4104ms
    diag: rows=5,manifestReachable=3 primevids=200/3 guru=200/0 flowcast=200/3 citadel=200/2 quasar=timeout hindicast=timeout
    audio: en:2 unlabelled:1
    labels: English, English, —
    quality: auto · hosts: img1.hscow.com,img1.fcxmb.com,cdn.slowcloud.live
- source-12 tv:1396: 1 candidate(s) in 5612ms
    diag: candidates=15,reachable=1
    audio: unlabelled:1
    labels: —
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 3 candidate(s) in 5560ms
    diag: candidates=16,reachable=3
    audio: unlabelled:3
    labels: —, —, —
    quality: auto · hosts: vidzen.fun
## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)
- source-1: 1 row(s), 1 alive in 807ms · gzip.rousav.tech
- source-2: 5 row(s), 5 alive in 1045ms · embed.vidrift.in,gzip.rousav.tech
- source-3: 0 row(s), 0 alive in 170ms
- source-4: 0 row(s), 0 alive in 60ms
- source-5: 0 row(s), 0 alive in 191ms
- source-7: 0 row(s), 0 alive in 257ms
- source-8: 1 row(s), 1 alive in 3396ms · img1.hscow.com
- source-9: 0 row(s), 0 alive in 459ms
- source-10: 0 row(s), 0 alive in 1225ms
- source-11: 0 row(s), 0 alive in 315ms
- source-12: 1 row(s), 1 alive in 5603ms · vidzen.fun
- source-13: 0 row(s), 0 alive in 45ms
- source-14: 3 row(s), 3 alive in 4104ms · img1.hscow.com,cdn.slowcloud.live
- source-15: 0 row(s), 0 alive in 288ms
- source-16: 0 row(s), 0 alive in 1ms
- source-17: 0 row(s), 0 alive in 0ms
- source-18: 0 row(s), 0 alive in 354ms
- source-19: 0 row(s), 0 alive in 559ms
- source-20: 0 row(s), 0 alive in 175ms
- source-21: 0 row(s), 0 alive in 3194ms
- summary: 5/20 lanes produced rows for this episode from a US runner
## 6. Source 21 — Vidout catalogue, live
- tv 1396 S1E1: 1 row(s), 0 alive in 236ms · host sw5.aurorionacademy.site
- tv 1396 S1E4: 1 row(s), 0 alive in 553ms · host sw5.aurorionacademy.site
- tv 66732 S4E1: 1 row(s), 1 alive in 924ms · host dd2stliwt0bc.homechefrecipes.sbs
    audio: hi,en · multiAudio=true
- tv 76479 S1E1: no catalogue entry (434ms)
- movie 10138: 1 row(s), 1 alive in 197ms · host wt4pjiive9agjpl.planetexploration.space
    audio: hi,ta,te,en · multiAudio=true
- movie 27205: no catalogue entry (348ms)
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

source-2   raw=8     229ms :: 2 req · vidrock.net 403 · embed.vidrift.in 200
source-10  raw=3     865ms :: 19 req · embed.vidrift.net 200×12 · new.vidnest.fun 200×3 · new.vidnest.fun 502×3 · i-arch-400.geffe448mik.com 404
source-12  raw=3    3649ms :: 31 req · vidzen.fun 200×17 · vidzen.fun 403×12 · vidzen.fun 502 · vidzen.fun timeout
source-1   raw=1     375ms :: 1 req · vidbolt.xyz 200
source-14  raw=1    4104ms :: 9 req · scrapper.rivestream.app 200×3 · scrapper.rivestream.app timeout×3 · cdn.slowcloud.live 200 · cdn1.slowcloud.live TypeError
source-20  raw=1    1460ms :: 3 req · patient-cherry.workerscloud32.workers.dev 200×2 · moviesapi.to 200
source-11  raw=0     239ms :: 1 req · streamdata.vaplayer.ru 404
source-13  raw=0     133ms :: 1 req · freakyniki.elaxo.lol 403
source-15  raw=0     205ms :: 1 req · mapple.fun 200
source-16  raw=0       6ms :: 0 req
source-17  raw=0       4ms :: 0 req
source-18  raw=0     829ms :: 2 req · blakiteapi.xyz 200×2
source-19  raw=0       3ms :: 0 req
source-21  raw=0     800ms :: 2 req · cdn.jsdelivr.net 200 · suw.halcyoncreative.site TypeError
source-3   raw=0     159ms :: 2 req · vidsync.pro 200×2
source-4   raw=0     143ms :: 1 req · bingr.one 403
source-5   raw=0     226ms :: 1 req · nxsha.space 200
source-7   raw=0     225ms :: 1 req · nxsha.space 200
source-8   raw=0    3235ms :: 6 req · core.vidzee.wtf 200×2 · core.vidzee.wtf 400 · core.vidzee.wtf 404 · cdn.slowcloud.live 200
source-9   raw=0     365ms :: 2 req · vixsrc.to 200×2
```

## Source health — tv 1396 S1E1 (Breaking Bad)
```
[selftest] TMDB_API_KEY is not set: adapters that need title/year fallback will report 0.

[selftest] tv/1396: 5/20 sources returned candidates

source-2   raw=5     226ms :: 2 req · vidrock.net 403 · embed.vidrift.in 200
source-12  raw=4    4463ms :: 30 req · vidzen.fun 200×19 · vidzen.fun 403×8 · vidzen.fun 404 · vidzen.fun 502
source-14  raw=3    4104ms :: 11 req · scrapper.rivestream.app 200×4 · scrapper.rivestream.app timeout×2 · img1.hscow.com 200×2 · cdn1.slowcloud.live TypeError
source-1   raw=1     228ms :: 1 req · vidbolt.xyz 200
source-8   raw=1    3206ms :: 7 req · core.vidzee.wtf 200×3 · core.vidzee.wtf 400 · img1.hscow.com 200 · cdn.slowcloud.live 200
source-10  raw=0    1705ms :: 12 req · embed.vidrift.net 404×4 · new.vidnest.fun 200×3 · new.vidnest.fun 502×3 · i-arch-400.geffe448mik.com 404×2
source-11  raw=0     299ms :: 1 req · streamdata.vaplayer.ru 404
source-13  raw=0     150ms :: 1 req · freakyniki.elaxo.lol 403
source-15  raw=0     368ms :: 1 req · mapple.fun 200
source-16  raw=0       5ms :: 0 req
source-17  raw=0       5ms :: 0 req
source-18  raw=0     784ms :: 2 req · blakiteapi.xyz 200×2
source-19  raw=0       3ms :: 0 req
source-20  raw=0     298ms :: 1 req · moviesapi.to 404
source-21  raw=0     975ms :: 2 req · cdn.jsdelivr.net 200 · sw5.aurorionacademy.site TypeError
source-3   raw=0     206ms :: 2 req · vidsync.pro 200×2
source-4   raw=0     112ms :: 1 req · bingr.one 403
source-5   raw=0     222ms :: 1 req · nxsha.space 200
source-7   raw=0     227ms :: 1 req · nxsha.space 200
source-9   raw=0     458ms :: 2 req · vixsrc.to 200×2
```
