# Provenance + Sources 14/12 expansion report

Run: 43696698159 on arena/399224d8-elfura at 2026-11-15T08:56:24Z

```
# provenance + expansion probe — 2026-11-15T08:55:01.223Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto 0d907a5e — manifest paretocdn.site → segment paretocdn.site (CDN serving its own segments (single origin))
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 1 row(s), 1 alive
    · hls auto 1cb983cd — manifest prx-1566-ant-r.vmpx.online → segment prx-1566-ant-r.vmpx.online (relay host serving its own segments)
- source-19 tv:95479:Jujutsu Kaisen:1:1: 0 row(s), 0 alive

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1108ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 77ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStR3igX74v83_z7rxjEZuMfSU.D8BOfTV-/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 20ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 54ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 36ms rows=0 root=error formats=none hosts=none
- awsind: http=200 25ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 11ms rows=0 root=error formats=none hosts=none
- stvv: http=200 13ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 13ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (Breaking Bad S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_eMs0CIUQd | hls@self/api/stream/v1_I-YabwQfU | hls@self/api/stream/v1_7Pif4u9o3
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_T3gVCXxSA
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_JhPr5FwhT
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_khtkYMm9V
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_LdpVfzYTt
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_T3Co397S5 | hls@self/api/stream/v1_M42SNbh6y
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment v2.streamsiteuk.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_IZkVLDxwx
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_uSrWVnAQb | hls@self/api/stream/v1_p4wOrd33B | hls@self/api/stream/v1_65ytzl-J1
    liveness: 0/4 alive (4 confirmed dead)
```
