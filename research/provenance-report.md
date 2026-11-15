# Provenance + Sources 14/12 expansion report

Run: 43734876356 on arena/399224d8-elfura at 2026-11-15T16:23:08Z

```
# provenance + expansion probe — 2026-11-15T16:20:11.938Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 0 alive
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 1 alive
    · hls auto bbf0884c — manifest prx-1331-ant-q.vmpx.online → segment prx-1331-ant-q.vmpx.online (relay host serving its own segments)
- source-19 tv:95479:Jujutsu Kaisen:1:1: 1 row(s), 1 alive
    · hls auto ac098582 — manifest prx-1331-ant-q.vmpx.online → segment prx-1331-ant-q.vmpx.online (relay host serving its own segments)

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1152ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 216ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR0bdX9Cn7-OkK5NnQq9F4_8.-sgoHR8V/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 1103ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 126ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 71ms rows=0 root=error formats=none hosts=none
- awsind: http=200 27ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 47ms rows=0 root=error formats=none hosts=none
- stvv: http=200 32ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 40ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_yT97M_Fr3 | hls@self/api/stream/v1_2MOu7Z2zm | hls@self/api/stream/v1_Tc0LCnHGR
    liveness: 0/4 alive (0 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_BHLJ6IsKm
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_Z2Loo1cOk
    liveness: 0/1 alive (0 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_9BZH7QqDW
    liveness: 0/1 alive (0 confirmed dead)
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_LMlhvy6H2
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_4OdKk4ETa | hls@self/api/stream/v1_IbD2DYMZX
    liveness: 1/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment rapid-feather-11de.mue2rxjlgdcr.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1__t41wVdW7
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_1R26olVWN | hls@self/api/stream/v1_vTaTe7-11 | hls@self/api/stream/v1_P50YLbOT5
    liveness: 0/4 alive (0 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_4GaqE2Wgp | hls@self/api/stream/v1_RffXedxp5 | hls@self/api/stream/v1_3-T2GRR1E
    liveness: 0/4 alive (3 confirmed dead)
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_GzckucHX6
    liveness: 0/1 alive (0 confirmed dead)
- venus: http=200 rows=1 mp4@self/api/stream/v1_pzTENLxwi
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_-U2tALehd
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_uL4INil7Z
    liveness: 0/1 alive (0 confirmed dead)
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_Mk4aboycG
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_MVzeh1mE6 | hls@self/api/stream/v1_UHzBwt67m
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment dark-grass-3324.muo7rayr01nj.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_KFC3t2ygu
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=5 hls@self/api/stream/v1_glTylQrsI | hls@self/api/stream/v1_umJ5dlL8S | hls@self/api/stream/v1_fs<n>-uKe
    liveness: 0/5 alive (4 confirmed dead)

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 3 candidate(s) in 4106ms
    diag: rows=5,manifestReachable=3 guru=200/0 primevids=200/3 flowcast=200/3 citadel=200/2 quasar=timeout hindicast=timeout
    audio: hi:2 unlabelled:1
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live
- source-14 movie:693134: 0 candidate(s) in 4102ms
    diag: rows=2,manifestReachable=0 guru=200/0 primevids=200/2 citadel=timeout flowcast=timeout quasar=timeout hindicast=timeout
    audio: 
    quality: none · hosts: 
- source-14 movie:913290: 1 candidate(s) in 4103ms
    diag: rows=3,manifestReachable=1 primevids=200/3 guru=200/0 citadel=timeout flowcast=timeout quasar=timeout hindicast=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-12 tv:1396: 4 candidate(s) in 5097ms
    diag: candidates=15,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 2 candidate(s) in 3694ms
    diag: candidates=17,reachable=2
    audio: unlabelled:2
    quality: auto · hosts: vidzen.fun
## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)
- source-1: 1 row(s), 1 alive in 942ms · gzip.rousav.tech
- source-2: 5 row(s), 5 alive in 1752ms · embed.vidrift.in,gzip.rousav.tech
- source-3: 0 row(s), 0 alive in 196ms
- source-4: 0 row(s), 0 alive in 157ms
- source-5: 0 row(s), 0 alive in 311ms
- source-7: 0 row(s), 0 alive in 270ms
- source-8: 1 row(s), 1 alive in 3302ms · img1.hscow.com
- source-9: 0 row(s), 0 alive in 534ms
- source-10: 0 row(s), 0 alive in 2475ms
- source-11: 0 row(s), 0 alive in 465ms
- source-12: 4 row(s), 4 alive in 5604ms · vidzen.fun
- source-13: 0 row(s), 0 alive in 86ms
- source-14: 3 row(s), 3 alive in 4103ms · img1.hscow.com,cdn.slowcloud.live
- source-15: 0 row(s), 0 alive in 383ms
- source-16: 0 row(s), 0 alive in 0ms
- source-17: 0 row(s), 0 alive in 1ms
- source-18: 0 row(s), 0 alive in 559ms
- source-19: 0 row(s), 0 alive in 7001ms
- source-20: 0 row(s), 0 alive in 333ms
- source-21: 0 row(s), 0 alive in 1331ms
- summary: 5/20 lanes produced rows for this episode from a US runner
## 6. Source 21 — Vidout catalogue, live
- tv 1396 S1E1: 1 row(s), 0 alive in 692ms · host sw5.aurorionacademy.site
- tv 1396 S1E4: 1 row(s), 0 alive in 1115ms · host sw5.aurorionacademy.site
- movie 10138: 1 row(s), 1 alive in 476ms · host wt4pjiive9agjpl.planetexploration.space
    audio: hi,ta,te,en · multiAudio=true
- movie 27205: no catalogue entry (646ms)
## 7. Source 21 transport checks (status codes only)
- tv host plain: 0  TypeError:ECONNRESET
- tv host referred: 0  TypeError:ECONNRESET
- movie host plain: 404 text/html <html>\n<head><title>404 Not Found</titl
- movie host referred: 200 application/vnd.apple.mpegurl #EXTM3U\n\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-I
```
