# Source 1 case study: why it is resilient, and why other sources vanished

**Reviewed against commit `5f1eca4` and the live-source matrix run `43645835558`.** The audit checks provider resolution plus manifest/child-playlist and sample media-byte reachability from GitHub Actions. It does not establish playback from a user's browser or Odyssey deployment.

## First: Source 14 was not removed

`source-14` is still registered in `backend/src/sources/registry.ts`. It is enabled unless `ELFURA_RIVE_CITADEL_ENABLED=0`; `.env.example` sets that toggle to `1`. Its adapter at `backend/src/sources/source14.ts` still validates signed Citadel HLS URLs, restricts their host/path, checks expiry, independently verifies the manifest, and drops candidates that fail the reachability check.

The screenshot's `English · Citadel label (unverified)` is specifically an **audio-language claim**: the provider labels the candidate English, but its manifest does not prove that language. It is not a dead-stream verdict. In the latest matrix Source 14 returned at least one verified option on 17 of 21 test titles.

## What the UI was actually doing wrong

Two global choices hid otherwise healthy streams:

1. `backend/src/sources/selection.ts` capped ordinary single-track fallbacks at **two total**, not two per adapter. A title with one multi-audio stream plus one single-track stream could therefore show only two server rows even when more providers had passed liveness checks.
2. `backend/src/sources/registry.ts` released the resolver shortly after the first adapter returned. Its 450 ms race/grace favored quick adapters and omitted slower results before the player menu was assembled.

These are selection/scheduling bugs, not evidence that Source 14 was removed. They are fixed: the bounded fallback cap is now 20, selection gives each provider a first slot before taking alternate candidates, and normal requests wait up to 1.3 seconds (anime up to 2.6 seconds) for other adapters to join. Metadata's idle wait was shortened so the extra provider grace does not consume the startup budget. Regression tests cover 15 healthy providers and a provider that resolves after the first one.

## Why the Source 1 family is resilient

`source1.ts` is not one endpoint. The registry exposes the direct VidBolt path as `source-1`, and the Source 1 adapter factory supplies the related `source-2` group with independent VidRift/Orion, VidBolt, and VidRock paths. The family:

- starts independent paths concurrently and uses a short grace instead of waiting indefinitely for a failing path;
- builds the movie/TV endpoint and season/episode parameters explicitly;
- sends the player-specific `Referer`, `Origin`, and User-Agent, then carries the required media headers through the sealed playback ticket;
- understands VidRift's boot token and Orion routes, preferring direct authenticated HLS while retaining a standby route where available;
- decrypts VidRock tokens and uses its observed media-header contract (a blank User-Agent, no Origin/Referer) rather than applying one generic header set to every host;
- rejects unsafe/embed/placeholder outputs, deduplicates routes, and cools down failed sub-origins;
- treats server-name languages as single-track hints and does not claim multi-audio unless manifest evidence supports it. The common liveness verifier removes confirmed-dead URLs when healthy alternatives exist.

That combination—**several independent routes, provider-aware request behavior, a fast failover path, and shared manifest verification**—is the reusable part. It is not appropriate to copy Source 1's VidRock crypto or headers into unrelated providers. Each adapter still needs its own real endpoint parser and headers; the common registry should own scheduling, verification, ranking, and retaining healthy providers.

## Live coverage: no source is perfect for every title

Latest 21-title audit, counting a source as a pass when at least one option passed the workflow's manifest/media-byte checks:

| Adapter | Passing titles | Failed candidate options | Interpretation |
|---|---:|---:|---|
| Source 1 / VidBolt | 12/21 | 0 | Strong movie/TV coverage, not universal. |
| Source 2 / VidRift + VidRock | 18/21 | 0 | Highest coverage in this matrix; same resilient Source 1 family. |
| Source 5 / Nxsha | 12/21 | 6 | Keep reachable lanes; reject failed candidates, not the whole adapter. |
| Source 7 / ScreenScape | 6/21 | 0 | Useful title-dependent fallback. |
| Source 8 / VidZee | 6/21 | 0 | Useful title-dependent fallback. |
| Source 12 / VidZen | 5/21 | 0 | Sparse, but demonstrably not dead. |
| Source 14 / Citadel | 17/21 | 0 | Not removed; strong coverage, with language labels explicitly unverified. |
| Source 17 / Stremio addons | 2/21 | 1 | Addon configuration/title dependent. |
| Sources 4, 9, 10, 11, 13, 15, 16 | 0/21 | 2 on Source 10 | No successful option in this sample. These are already opt-in/off by default. A 21-title miss is not proof of global death; don't silently delete adapters on that basis. |

The latest matrix job itself is not fully green: some titles/providers return no result or have individual candidate failures. The useful result is per-source evidence above, not a blanket “all providers work” claim.

## Changes made from the case study

- Restored provider breadth in the common selector, preserving one result per provider before taking a second from any provider.
- Gave slower adapters a bounded chance to return before the menu is sealed.
- Added tests proving 15 independent verified providers survive selection and a slower healthy adapter joins the response.
- Kept Source 14 registered and enabled by its existing default; retained the visible “unverified” language warning rather than turning a provider label into a false audio guarantee.

## Deployment

The updated Pterodactyl bundle is built by GitHub Actions for this branch and is committed as `elfura-pterodactyl.zip` at commit `5f1eca4`. A running Odyssey/Pterodactyl instance must be updated to that build for the selector and grace-period fixes to take effect.
