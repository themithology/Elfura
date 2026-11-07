# Multilingual download API research

Research run: 2026-11-07. Research only: no download route, provider, proxy, or changes to the playback pipeline have been deployed.

## Goal
Standalone `/dl/` flow: title and episode identity → language → actual files by quality → shareable download landing page. The mockup is visual reference, not proof of its backend. Source and language selection must not interfere with the working player.

## Live findings

### MovieBox candidate (not yet suitable)

The independently maintained [Moviebox-API](https://github.com/kelvinodgar-tech/Moviebox-API) documents separate dub subjects, MP4 qualities, sizes and short-lived signed links. It has no license file identified through GitHub's license endpoint; do not copy its code without permission or a suitable license. The researcher checked out an unmodified temporary copy solely for probing.

[Live run 42341048553](https://github.com/themithology/Elfura/actions/runs/42341048553) obtained matrices in ~1.5–3 seconds from GitHub Actions. Godzilla Minus One (2023) advertised nine language variants, including Hindi (1080p/480p), Tamil and Japanese. **No language or actual file was verified**: the first HTTP range requests got `426 Forbidden` HTML instead of MP4 bytes. [Run 42341102476](https://github.com/themithology/Elfura/actions/runs/42341102476) reproduced 426 with both HTTP/1.1 and HTTP/2; this was not a simple protocol-upgrade problem. It could differ by region/network, but no assumptions should be made.

The lookup has serious identity problems if the first search result is trusted: searching `Jawan` returned `Jawan 2` (2026), `Dune` matched the 1984 film instead of the 2021 title, and `Squid Game` returned the season 3 entry when season 1 was requested. Even the advertised Hindi Godzilla file duration was 5914s versus 7478s for the original; it may be truncated, different cut or mislabelled. Do not treat search rank or dub labels as truth. Resolve identity by TMDB-to-IMDb/year/type with a fail-closed confidence policy, explicitly match season and episode and verify each dub is actually correct.

Signed URL validity must be checked at download time, with safe bounded range reads, content type/signature, and resume capability; a valid 206/bytes is not itself proof of full-file integrity or audible language. Test real browser download, full file integrity for at least one representative permitted asset, language/audio tracks with ffprobe or actual playback, Indian server reachability, expiry/resume and provider limits.

### Nuvio HDHub4u candidate (not established)

[Archived MIT NuvioStreamsAddon](https://github.com/tapframe/NuvioStreamsAddon) has direct-file resolvers, but [run 42341164690](https://github.com/themithology/Elfura/actions/runs/42341164690) returned zero options for both Godzilla Minus One and Jawan in a GitHub runner. No download was verified. Source code includes `rejectUnauthorized: false`; never copy that behavior into Elfura. The upstream website/region or host could behave differently.

Other candidate Nuvio file resolvers (4KHDHub, MoviesDrive) and official operator-supplied file/CDN sources need independent live validation, permission/license checks, and exact-identity matching. Torrents are not HTTP downloadable files, and an HLS playlist is not a direct MP4/MKV. The user previously chose direct upstreams and rejected Vidara and OFC; neither is a candidate.

## Safe proposed architecture

- Keep `/dl/movie/:tmdb` and `/dl/tv/:tmdb/:season/:episode` isolated from `/embed` and the source-selection/relay machinery. Resolve title IDs through reliable metadata; never display a different title on a fuzzy match.
- Query provider adapters asynchronously and independently, dedupe with accurate language/format/quality evidence and show only actually available options. Short cache and bounded concurrency; do not hold up player startup.
- Landing pages must use opaque, short-lived, scoped signed tickets. Expose no raw source URLs in catalog JSON. Regenerate upstream signatures at click time. A shareable page URL is not the same thing as a permanent upstream URL.
- Redirect/direct offload minimizes server bandwidth, but exposes the final URL to the downloader; a proxy hides it but uses the full download bandwidth and must implement HTTP Range, HEAD, proper 200/206, safe filename, disconnect cleanup and expiry/refresh. This is a deployment tradeoff; do not silently choose high-bandwidth relaying.
- Never accept arbitrary upstream URLs or file paths from clients. Strict source host allowlists; validate DNS and connection destination and each redirect; deny private, loopback, link-local and metadata addresses; use outbound restrictions, timeouts, finite redirects, streaming/backpressure, concurrency and byte limits. The sample upstream open `?url=` download proxy is not safe to copy as an API.
- Apply route-specific per-IP/session limits, short-lived tickets, throttled issuance, server-side authorization, optional edge/WAF bot challenges and no-store response headers. Test legitimate mobile/download managers, shared IPs and paused/resumed downloads. CORS, obscurity, timers and encrypted frontend JSON do not prevent an automated client that can act as a user. No design can prevent a real recipient from saving/sharing the resulting file.
- Test mobile UI, accessibility, slow and missing provider states, title/year/episode correctness, duplicate/expired links, no-source behavior, bot rates, SSRF, Range and HEAD, cache invalidation, and actual playback regression. Deploy first to the separate test server; leave production untouched.

## Open decisions

1. Which intended movie/TV route shapes and whether public share pages should be reusable or expire?
2. Direct upstream downloads (low bandwidth, final host visible) versus first-party proxy (origin private, potentially massive bandwidth)?
3. Is there an authorized file/CDN provider or a sample direct download link to test? No researched public provider is verified working from the hosting region yet.
