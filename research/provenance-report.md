# Provenance + Sources 14/12 expansion report

Run: 43746021165 on arena/399224d8-elfura at 2026-11-15T18:20:56Z

```
# provenance + expansion probe — 2026-11-15T18:18:51.537Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto 85ad3ab9 — manifest patient-cherry.workerscloud32.workers.dev → segment patient-cherry.workerscloud32.workers.dev (relay host serving its own segments)
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 0 row(s), 0 alive
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto 88b5a88e — manifest prx-1331-ant-q.vmpx.online → segment prx-1331-ant-q.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1665ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 160ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR7yqN9HnPbgyU-u_Zy-wNP4.mH-xkoha/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 82ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: http=200 2791ms rows=0 root=data formats=none hosts=none
- guru: http=200 226ms rows=0 root=data formats=none hosts=none
- hindicast: http=200 764ms rows=0 root=data formats=none hosts=none
- mhbox: http=200 15ms rows=0 root=error formats=none hosts=none
- awsind: http=200 39ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 43ms rows=0 root=error formats=none hosts=none
- stvv: http=200 20ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 52ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_vIQAwACut | hls@self/api/stream/v1_aEo8L98wa | hls@self/api/stream/v1_apuX7jDdH
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_uTzcHDdqp
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_GGCUAxrym
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_5dNLUZ_ya
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=0 
- uranus: http=200 rows=2 hls@self/api/stream/v1_FUCBjTOpx | hls@self/api/stream/v1_WJIzjEP4c
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment morning-sun-9bbb.mvmcsih5z2sd.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_KIzg2B-k4
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_DTTUPV2nK | hls@self/api/stream/v1_rc0QZfw8w | hls@self/api/stream/v1_euLhlucrl
    liveness: 0/4 alive (4 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_kXUBWpo03 | hls@self/api/stream/v1_8kcezdUwt | hls@self/api/stream/v1_9JPDBvmQQ
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_CoSTJ-iY0
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- venus: http=200 rows=1 mp4@self/api/stream/v1_wxPTn4hFY
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_1fFUfXq38
    liveness: 0/1 alive (0 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_1o0bpRme_
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_9Nr0Zn7YV
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_dJpxl7ihQ | hls@self/api/stream/v1_elYZbEEo5
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment sparkling-wave-ad4a.hostnomic.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_iVBJTkqHj
    liveness: 0/1 alive (1 confirmed dead)
- helios: http=200 rows=5 hls@self/api/stream/v1_WbEYdGj-u | hls@self/api/stream/v1_-zrn1Cr9L | hls@self/api/stream/v1_AkRQBkGsD
    liveness: 0/5 alive (4 confirmed dead)

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 1 candidate(s) in 4103ms
    diag: rows=3,manifestReachable=1 flowcast=200/3 guru=200/0 primevids=200/3 hindicast=200/0 citadel=timeout quasar=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-14 movie:693134: 0 candidate(s) in 4102ms
    diag: rows=2,manifestReachable=0 guru=200/0 primevids=200/2 hindicast=200/0 citadel=timeout flowcast=timeout quasar=timeout
    audio: 
    quality: none · hosts: 
- source-14 movie:913290: 1 candidate(s) in 4103ms
    diag: rows=3,manifestReachable=1 flowcast=200/2 primevids=200/3 guru=200/0 hindicast=200/0 citadel=timeout quasar=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-12 tv:1396: 4 candidate(s) in 4273ms
    diag: candidates=14,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 3 candidate(s) in 3609ms
    diag: candidates=17,reachable=3
    audio: unlabelled:3
    quality: auto · hosts: vidzen.fun
## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)
- source-1: 1 row(s), 1 alive in 1113ms · gzip.rousav.tech
- source-2: 5 row(s), 5 alive in 1317ms · embed.vidrift.in,gzip.rousav.tech
- source-3: 0 row(s), 0 alive in 333ms
- source-4: 0 row(s), 0 alive in 235ms
- source-5: 0 row(s), 0 alive in 301ms
- source-7: 0 row(s), 0 alive in 260ms
- source-8: 1 row(s), 1 alive in 3527ms · img1.hscow.com
- source-9: 0 row(s), 0 alive in 579ms
- source-10: 0 row(s), 0 alive in 2867ms
- source-11: 0 row(s), 0 alive in 413ms
- source-12: 4 row(s), 4 alive in 4177ms · vidzen.fun
- source-13: 0 row(s), 0 alive in 146ms
- source-14: 3 row(s), 3 alive in 4104ms · img1.hscow.com,cdn.slowcloud.live
- source-15: 0 row(s), 0 alive in 264ms
- source-16: 0 row(s), 0 alive in 1ms
- source-17: 0 row(s), 0 alive in 0ms
- source-18: 0 row(s), 0 alive in 505ms
- source-19: 0 row(s), 0 alive in 3140ms
- source-20: 0 row(s), 0 alive in 265ms
- source-21: 0 row(s), 0 alive in 1346ms
- summary: 5/20 lanes produced rows for this episode from a US runner
## 6. Source 21 — Vidout catalogue, live
- tv 1396 S1E1: 1 row(s), 0 alive in 864ms · host sw5.aurorionacademy.site
- tv 1396 S1E4: 1 row(s), 0 alive in 1266ms · host sw5.aurorionacademy.site
- tv 66732 S4E1: 1 row(s), 1 alive in 1393ms · host dd2stliwt0bc.homechefrecipes.sbs
    audio: hi,en · multiAudio=true
- tv 76479 S1E1: no catalogue entry (595ms)
- movie 10138: 1 row(s), 1 alive in 1192ms · host wt4pjiive9agjpl.planetexploration.space
    audio: hi,ta,te,en · multiAudio=true
- movie 27205: no catalogue entry (620ms)
## 7. Source 21 transport checks (status codes only)
- tv host plain: 0  TypeError:ECONNRESET
- tv host referred: 0  TypeError:ECONNRESET
- movie host plain: 404 text/html <html>\n<head><title>404 Not Found</titl
- movie host referred: 200 application/vnd.apple.mpegurl #EXTM3U\n\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-I
```
