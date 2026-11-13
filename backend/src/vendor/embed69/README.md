# Embed69 adapter attribution

Source 18 adapts the Embed69 discovery, bounded proof-of-work, link-decryption, and host-extractor flow from [xuper-plugin/kino-plugin-embed69](https://github.com/xuper-plugin/kino-plugin-embed69), under Apache License 2.0. The upstream repository's `LICENSE` and `NOTICE` are preserved here. Elfura-specific changes are documented in `backend/src/sources/source18.ts`.

This adapter intentionally omits hidden-browser capture for VOE's rotating-domain path, limits host redirects, and reports provider language only as an unverified claim. It is disabled by default until explicitly enabled and tested against live media.
