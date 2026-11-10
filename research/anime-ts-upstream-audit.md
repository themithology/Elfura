# Anime source TypeScript audit

Date: 2026-11-04

## DesiDubAnime

Reference TypeScript: [Anivault-API `src/scrapers/desidub.ts`](https://github.com/SH0MIK/Anivault-API/blob/main/src/scrapers/desidub.ts).

Relevant implementation flow: `getDesidubEpisodes` reads the show's page / `get_episodes` AJAX; `getDesidubServers` decodes `data-embed-id` and classifies SUB/DUB server rows; `getDesidubStream` resolves supported player hosts. The resolver includes direct HLS extraction paths for VidMoly, StreamRuby, EarnVids, and DesiDub's Cloud player, plus other more involved server resolvers. The copied project also has iframe-only fallbacks; Elfura deliberately omits those.

Elfura's Source 16 is an independent bounded port for the site's WordPress catalog + episode/server pages and direct HLS only. It currently supports direct extraction from VidMoly / Ruby-family / Smoothpre-family / DesiDub Cloud pages, rejects other/embed-only results, caps pages/candidates, and serializes origin requests with a cooldown after HTTP 429.

## Anikoto

Reference TypeScript: [Anivault-API `src/scrapers/anikoto.ts`](https://github.com/SH0MIK/Anivault-API/blob/main/src/scrapers/anikoto.ts).

Relevant implementation flow: search/filter page -> `/ajax/episode/list/{id}` -> `/ajax/server/list?servers=...` -> `/ajax/server?get=...`. Its Vidstream resolver reads `data-ep-id`, `type`, and `domain2_url`, requests `save_data.php?id={epId}-{type}`, then extracts `data.sources[0].url`. It also has MegaCloud/MegaPlay extractors and Kiwi mapper integrations; those are not required for Elfura Source 17's first direct-only pass.

Elfura's Source 17 implements the site AJAX flow and direct Vidstream save-data route, with literal HLS discovery as a limited fallback. It omits external hosted mapper APIs and discards iframe-only/player-only links.

## Evidence boundary

Automated tests mock the provider pages, AJAX payloads, embed-player HTML, and HLS manifest. They verify adapter protocol, source-type separation, SSRF checks, and manifest parsing—not current live provider availability, browser playback, audio content, or subtitle correctness. A `SUB`/`DUB` server label is exposed as a provider-labeled choice and is not treated as an audio-language fact.
