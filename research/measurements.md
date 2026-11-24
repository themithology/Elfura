# What the lanes actually do

Measured on GitHub runners through Chromium and plain HTTP. The raw rows are in
[measurements.json](measurements.json); this file is the reading of them.

Two runs so far, 128 rows each, four probe titles per lane
(Fight Club, Inception, Game of Thrones S1E1, Naruto S1E1). Browser rows are real
pages that were opened, clicked and inspected frame by frame; the bytes were then
fetched outside the page and counted.

## The short version

| | |
| --- | --- |
| Lanes that produced playable bytes on both runs | **1** — rivestream-citadel |
| Lanes that produced bytes once, then not | 5 — vidnest, mikaza, animesalt, vidora, greybox |
| Lanes that produced bytes on neither run | 15 |
| Lanes that returned a way to find media on plain HTTP | 2 — rivestream-citadel, greybox (and greybox's media did not play) |
| Lanes that *needed* a browser to find anything | 4 — mikaza, animesalt, vidora, vidnest (once) |

**No lane was saved by a browser that plain HTTP could not also have reached.**
That is the finding that decides the infrastructure question, and it is worth
being blunt about: a headless Chromium in production buys us nothing yet. The
lane that plays — the only one with a clean 4/4 — is a JSON API.

## Per lane

`playable` counts probe titles whose final segment returned real bytes within the
deadline. A 200 that is an HTML error page, or a manifest that answers 50x, is a
failure.

| lane | playable | needs browser | what it is |
| --- | --- | --- | --- |
| rivestream-citadel | **4/4** (twice) | no | `scrapper.rivestream.app/api/provider?provider=citadel&id=` → signed HLS on `img1.hscow.com` / `img1.fcxmb.com`; 1037 ms first call, segments 206 in ~250 ms, no DRM |
| greybox | 0/4 | no | JSON answers on movie, TV returns **429** on every run; the manifest behind the JSON answered **502**. Previously counted as "2/4 media" before 429 and 502 were treated honestly |
| vidnest | 0–2/8 | once | browser found `pwcloud.animanga.fun` HLS on one run, nothing on the next; HTTP is a Cloudflare challenge |
| mikaza | 1/2 | yes | anime only; browser found a 5 MB MP4 on `mikaza.buzz` |
| animesalt | 1/2 | yes | anime only; browser found `ravok.buzz` HLS |
| vidora | 1/8 | yes | three different CDNs across four titles, one played |
| vixsrc | 0/8 | — | Cloudflare "Attention Required" for both HTTP and Chromium |
| nxsha | 0/8 | — | Cloudflare challenge |
| mapple, vidzen | 0/8 | — | Cloudflare challenge |
| vidbolt | 0/8 | — | player path 404s; every embed URL recorded from the retired adapter points at a page that no longer exists |
| xpass | 0/8 | — | recorded player host does not resolve |
| tgvidx | 0/8 | — | marketing page, no player for a bare title query |
| watchout | 0/8 | — | catalogue host redirects to Google |
| bingr, vidsync, vidzee, blakite, megaplay, novuscloud | 0/8 | — | page answered, no media in it |

## What this means for the build

1. **Ship citadel first.** It is the only lane that passed twice, it needs no
   browser, and its first call is ~1 s with segments at ~250 ms. It is a
   fourteen-line adapter over an API we already know how to reach.
2. **Do not buy a browser yet.** Every browser-only lane is anime or flaky. Put
   the Chromium harness behind the measurement job, and revisit it when a lane
   is found that only a browser can open — with a row in this file to prove it.
3. **Cloudflare challenges are the real wall**, not JavaScript. Five lanes return
   "Attention Required" to a real Chromium on a datacenter IP. A browser does not
   solve those; residential egress might, and that is a proxy-pool decision the
   project already rejected once.
4. **Reliability is the scarce thing, not coverage.** vidnest went 2/8 → 0/8
   between two runs an hour apart. citadel went 4/4 → 4/4. The board should look
   like the second one.
