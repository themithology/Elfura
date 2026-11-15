# Provenance + Sources 14/12 expansion report

Run: 43735309296 on arena/399224d8-elfura at 2026-11-15T16:27:27Z

```
# provenance + expansion probe — 2026-11-15T16:24:55.218Z

## 1. Provenance of Sources 18-20
- source-20 movie:872585:Oppenheimer: 1 row(s), 1 alive
    · hls auto 21af0f6f — manifest paretocdn.site → segment paretocdn.site (CDN serving its own segments (single origin))
- source-18 tv:46260:Naruto:1:1: 4 row(s), 1 alive
    · hls auto a50c13d5 — manifest hugh.cdn.rumble.cloud → segment hugh.cdn.rumble.cloud (CDN serving its own segments (single origin))
- source-18 tv:95479:Jujutsu Kaisen:1:1: 4 row(s), 4 alive
    · mp4 720p 60f0af95 — direct mp4 object on hugh.cdn.rumble.cloud
    · mp4 480p c0399cc3 — direct mp4 object on hugh.cdn.rumble.cloud
- source-19 tv:46260:Naruto:1:1: 0 row(s), 0 alive
- source-19 tv:95479:Jujutsu Kaisen:1:1: 0 row(s), 0 alive

## 2. Source 14 provider sweep (scrapper API)
- citadel: http=200 1233ms rows=2 root=data formats=hls:2 hosts=img1.hscow.com:2
    labels: 720p | Hindi|Citadel ; 480p | Hindi|Citadel
    first url: img1.hscow.com/hls_mps/<hex>/720/index_287.m3u8
    provenance: manifest img1.hscow.com → segment img.hscow.com (edge → different segment host)
- primevids: http=200 225ms rows=3 root=data formats=hls:3 hosts=cdn.slowcloud.live:1,cdn2.slowcloud.live:1,cdn1.slowcloud.live:1
    labels: tcloud|PrimeVids ; dcloud|PrimeVids ; ipcloud|PrimeVids
    first url: cdn.slowcloud.live/tv/Qf7HOJ9QgO-abwHfQfStRysxfwY77F44hQdli-0x7ds.J-7wmpBV/bigtits.m3u8
    provenance: manifest cdn.slowcloud.live → segment p16-sg.tiktokcdn.com (edge → different segment host)
- flowcast: http=200 41ms rows=3 root=data formats=mp4:3 hosts=cors.corsflix.net:3
    labels: 720|FlowCast ; 480|FlowCast ; 360|FlowCast
    first url: cors.corsflix.net/proxy
    provenance: error TimeoutError
- quasar: error TimeoutError
- guru: http=200 80ms rows=0 root=data formats=none hosts=none
- hindicast: error TimeoutError
- mhbox: http=200 33ms rows=0 root=error formats=none hosts=none
- awsind: http=200 22ms rows=0 root=error formats=none hosts=none
- vidapi: http=200 14ms rows=0 root=error formats=none hosts=none
- stvv: http=200 14ms rows=0 root=error formats=none hosts=none
- streamflix: http=200 24ms rows=0 root=error formats=none hosts=none

## 3. Source 12 per-server sweep (tv 1396 S1E1)
- page http=200 bytes=54425 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_UrzkcOv7P | hls@self/api/stream/v1_bdpAsN8uH | hls@self/api/stream/v1_kjUsCyRWy
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=1 hls@self/api/stream/v1_4uk4yyFF7
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- jupiter: http=200 rows=1 hls@self/api/stream/v1_4Ktct-T0_
    liveness: 0/1 alive (1 confirmed dead)
- venus: http=200 rows=0 
- saturn: http=200 rows=0 
- mercury: http=200 rows=1 hls@self/api/stream/v1_U0dXP8sCw
    liveness: 1/1 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment vidzen.fun (CDN serving its own segments (single origin))
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_G_xPHGkhk
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1_DWv4zQR8g | hls@self/api/stream/v1_uHa3iWMAK
    liveness: 2/2 alive (0 confirmed dead)
    provenance: manifest http=403
- pluto: http=200 rows=1 hls@self/api/stream/v1_lgz7lRdTZ
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=4 hls@self/api/stream/v1_h0lwzb2_c | hls@self/api/stream/v1_2PNa6COk2 | hls@self/api/stream/v1_DLdrWdTa5
    liveness: 0/4 alive (4 confirmed dead)

## 3. Source 12 per-server sweep (movie 872585)
- page http=200 bytes=53509 token=yes
- hyperion: http=200 rows=4 hls@self/api/stream/v1_Ya5y4Wr3C | hls@self/api/stream/v1_kNJE5TS9- | hls@self/api/stream/v1_sEq5a3Xq7
    liveness: 0/4 alive (4 confirmed dead)
- mars: http=200 rows=0 
- jupiter: http=200 rows=1 hls@self/api/stream/v1_RxY-OLTyv
    liveness: 0/1 alive (0 confirmed dead)
- venus: http=200 rows=1 mp4@self/api/stream/v1_abWJ93KGT
    liveness: 0/1 alive (1 confirmed dead)
- saturn: http=200 rows=1 hls@self/api/stream/v1_Yl79iNjXT
    liveness: 0/1 alive (1 confirmed dead)
- mercury: http=200 rows=1 hls@self/api/stream/v1_QwvQGVgRZ
    liveness: 0/1 alive (0 confirmed dead)
- neptune: http=200 rows=0 
- earth: http=200 rows=1 hls@self/api/stream/v1_ZM9YpBKgG
    liveness: 0/1 alive (0 confirmed dead)
- uranus: http=200 rows=2 hls@self/api/stream/v1__rU4b94PQ | hls@self/api/stream/v1_fAhkIMfgF
    liveness: 1/2 alive (0 confirmed dead)
    provenance: manifest vidzen.fun → segment white-dream-9394.mvievyhp0bfk.workers.dev (edge → different segment host)
- pluto: http=200 rows=1 hls@self/api/stream/v1_zSSxKyW5y
    liveness: 0/1 alive (0 confirmed dead)
- helios: http=200 rows=5 hls@self/api/stream/v1_Q9aguHgwb | hls@self/api/stream/v1_UHBK8vqsM | hls@self/api/stream/v1_GpPWyz2ku
    liveness: 0/5 alive (4 confirmed dead)

## 4. Adapter-level results (what actually ships)
- source-14 tv:1396: 3 candidate(s) in 4106ms
    diag: rows=5,manifestReachable=3 flowcast=200/3 guru=200/0 primevids=200/3 citadel=200/2 quasar=timeout hindicast=timeout
    audio: hi:2 unlabelled:1
    quality: auto · hosts: img1.hscow.com,cdn.slowcloud.live
- source-14 movie:693134: 0 candidate(s) in 4102ms
    diag: rows=2,manifestReachable=0 guru=200/0 primevids=200/2 citadel=timeout flowcast=timeout quasar=timeout hindicast=timeout
    audio: 
    quality: none · hosts: 
- source-14 movie:913290: 1 candidate(s) in 4103ms
    diag: rows=3,manifestReachable=1 primevids=200/3 guru=200/0 flowcast=200/2 citadel=timeout quasar=timeout hindicast=timeout
    audio: unlabelled:1
    quality: auto · hosts: cdn.slowcloud.live
- source-12 tv:1396: 4 candidate(s) in 4740ms
    diag: candidates=15,reachable=4
    audio: unlabelled:4
    quality: auto · hosts: vidzen.fun
- source-12 movie:872585: 1 candidate(s) in 5321ms
    diag: candidates=17,reachable=1
    audio: unlabelled:1
    quality: auto · hosts: vidzen.fun
## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)
- source-1: 1 row(s), 1 alive in 941ms · gzip.rousav.tech
- source-2: 5 row(s), 5 alive in 1556ms · embed.vidrift.in,gzip.rousav.tech
- source-3: 0 row(s), 0 alive in 186ms
- source-4: 0 row(s), 0 alive in 153ms
- source-5: 0 row(s), 0 alive in 78ms
- source-7: 0 row(s), 0 alive in 38ms
- source-8: 1 row(s), 1 alive in 3486ms · img1.hscow.com
- source-9: 0 row(s), 0 alive in 68ms
- source-10: 0 row(s), 0 alive in 82ms
- source-11: 0 row(s), 0 alive in 344ms
- source-12: 0 row(s), 0 alive in 2601ms
- source-13: 0 row(s), 0 alive in 72ms
- source-14: 3 row(s), 3 alive in 4104ms · img1.hscow.com,cdn.slowcloud.live
- source-15: 0 row(s), 0 alive in 826ms
- source-16: 0 row(s), 0 alive in 1ms
- source-17: 0 row(s), 0 alive in 0ms
- source-18: 0 row(s), 0 alive in 455ms
- source-19: 0 row(s), 0 alive in 809ms
- source-20: 0 row(s), 0 alive in 329ms
- source-21: 0 row(s), 0 alive in 913ms
- summary: 4/20 lanes produced rows for this episode from a US runner
## 6. Source 21 — Vidout catalogue, live
- tv 1396 S1E1: 1 row(s), 0 alive in 1158ms · host sw5.aurorionacademy.site
- tv 1396 S1E4: 1 row(s), 0 alive in 821ms · host sw5.aurorionacademy.site
- tv 66732 S4E1: 1 row(s), 1 alive in 685ms · host dd2stliwt0bc.homechefrecipes.sbs
    audio: hi,en · multiAudio=true
- tv 76479 S1E1: no catalogue entry (661ms)
- movie 10138: 1 row(s), 1 alive in 1196ms · host wt4pjiive9agjpl.planetexploration.space
    audio: hi,ta,te,en · multiAudio=true
- movie 27205: no catalogue entry (495ms)
## 7. Source 21 transport checks (status codes only)
- tv host plain: 0  TypeError:ECONNRESET
- tv host referred: 0  TypeError:ECONNRESET
- movie host plain: 404 text/html <html>\n<head><title>404 Not Found</titl
- movie host referred: 200 application/vnd.apple.mpegurl #EXTM3U\n\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-I
```
