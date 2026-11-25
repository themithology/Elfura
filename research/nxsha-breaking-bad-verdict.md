# Breaking Bad S1E1 (TMDB 1395) — the URLs, so you can check them yourself

Measured on a GitHub runner, 8/8 nxsha lanes on offer. Every URL below is verbatim.
Fetch styles: **plain** (no headers), **row-headers** (what the API ships), **browser-like** (Referer+Origin+Accept+Range).

| lane | label | plain | browser-like | manifest audio | bytes proved |
|---|---|---|---|---|---|
| castle | `[English] - FHD 1080P` | 403 | 200 | — | 0 |
| castle | `[English] - HD 720P` | 403 | 200 | — | 0 |
| castle | `[English] - SD 480P` | 403 | 200 | — | 0 |
| vixolity | `Vixolity` | 502 | 502 | — | 0 |
| purstream | `Purstream · pulse · 1080p · MULTI` | 200 | 403 | fr,en,eng,fra | 131072 |
| ophim | `Vietsub (Tập 01)` | 200 | 206 | — | 131072 |

## The question you asked: is any of this actually Hindi?

**No. Not on this title.** The only row claiming multi-audio resolves its manifest to:

```
#EXTM3U
#EXT-X-VERSION:3

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Français",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="fr",URI="audio_fr/playlist.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=NO,AUTOSELECT=NO,LANGUAGE="en",URI="audio_en/playlist.m3u8"

#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO,LANGUAGE="eng",URI="subs_eng.vtt"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Français",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="fra",URI="subs_fra.vtt"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Français",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="fra",URI="subs_fra_5.vtt"

#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"
720p/playlist.m3u8

```

`fr` + `en` (and their 3-letter twins `fra`/`eng`). No `hi`, no `ta`, no `te`.
So on Breaking Bad there is **zero Hindi supply on nxsha**, and my rule was not
wrong to say so — but it reached that answer for the wrong reason, by refusing
rows it never looked at.

## The part that is my fault: working streams my rule throws away

These four serve real bytes and are currently discarded by the language rule:

### castle — `[English] - FHD 1080P` — **works**, 0 bytes proved
- plain: 403 · browser-like: **200**
- content-type: `application/vnd.apple.mpegurl; charset=utf-8` · manifest: True

```
https://catflix.nxstreamhub.workers.dev/stream/3d3054505252554d666c6b575a4e48566e4a46524968336474676b5143463362504e55544d5a7a4d45423155725247534e5a6a557739554f724a306350647a637a704562515657524f396b5933456a5770566e4d50746d534b42485671466b553334304d76746b513563574d7a4a31516d644665713557506c4a586430466d626e6c32556d556d6331525859756457615431545a74466d54355632536d456a4d35676a4d3255544f334554507a566d63704248654639444f314e54627563444f793846656c526d627039434d3441544d7651544d314d545a79676a596c46324e3149444d34675459786b54596856324e30596d4e6c4e474f304d445a34417a4e6c5a544e3559324c7a784761763032626a357964764e32636f35534d6e3157617638694f7a424864306857656c7432586c4a58646a56326366686e62/0/master.m3u8
```

### castle — `[English] - HD 720P` — **works**, 0 bytes proved
- plain: 403 · browser-like: **200**
- content-type: `application/vnd.apple.mpegurl; charset=utf-8` · manifest: True

```
https://catflix.nxstreamhub.workers.dev/stream/3d3d5150394555514d527a626f6c44636b78575a6b4a3061686c485632566b5771706c54334d574d58396b4d56354564533530594c42564d584231566d686e61613153565564314d6a5244556e426c596178475431386d524e467a4d34385762714a564e4b353064614a556576466c5379597a4d7a386b4d39556d633152585975645761545a535a795648646835325a704e56506c3157594f6c585a4c5a694d796b444f7959544e3563544d394d585a796c4763345630503455334d7435794e34497a583456475a756c324c77497a4e7651544d314d545a79676a596c46324e3149444d34675459786b54596856324e30596d4e6c4e474f304d445a34417a4e6c5a544e3559324c7a784761763032626a357964764e32636f35534d6e3157617638694f7a424864306857656c7432586c4a58646a56326366686e62/0/master.m3u8
```

### castle — `[English] - SD 480P` — **works**, 0 bytes proved
- plain: 403 · browser-like: **200**
- content-type: `application/vnd.apple.mpegurl; charset=utf-8` · manifest: True

```
https://catflix.nxstreamhub.workers.dev/stream/3d3054506e4e554f363932584c6856575a6447626d7447634c6c484d77645454314e474e5274476261464761464e4853344d57566d5244577751565a7a4d325551316d57705a5457686c304d7a6858524a46465230456d56305947524c6c6b4d7946576156466b5a4c4a3261325155546c646d63485656506c4a586430466d626e6c32556d556d6331525859756457615431545a74466d54355632536d496a4d35676a4d3255544f334554507a566d63704248654639444f314e54627563444f793846656c526d627039434d34517a4c3045544e7a556d4d3449575a6864544e7941444f3445574d354557596c64444e6d5a545a6a68444e7a51474f7763545a3255544f6d397963773132587a784761763032626a357964764e32636f35534d6e3157617638694f7a424864306857656c7432586c4a58646a56326366686e62/0/master.m3u8
```

### ophim — `Vietsub (Tập 01)` — **works**, 131072 bytes proved
- plain: 200 · browser-like: **206**
- content-type: `application/vnd.apple.mpegurl` · manifest: True

```
https://v7.kkphimplayer7.com/20260615/AIPqikid/index.m3u8
```

## What I still do not know, stated rather than hidden

castle answers **403** to a bare fetch and **200** with Referer+Origin+Accept+Range.
I changed four headers at once, so I cannot say which one mattered — that is a
confound, and the adapter currently sends only a User-Agent, so it would very
likely get the 403. This is the next thing to isolate properly, and it is the
difference between a lane that serves English 1080p and one that serves nothing.

purstream is the inverse: it serves **200** to a plain fetch and **403** with the
Range header. A player asks with Range. So its one working row is working in a
test harness that does not look like a player.

