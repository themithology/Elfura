# Aethoflix source inventory and duplication audit

Audit: 6 November 2026. Research only; Aethoflix and the ZXC mirror are not production dependencies.

## All 31 advertised labels

The family is what Aethoflix's current scan reports; it is a claim, not proof of the underlying CDN or an independent provider.

| Advertised family | Labels (API IDs) |
|---|---|
| VidBolt (11) | Orion (`orion`), Vega (`vega`), Callisto (`callisto`), Sirius (`sirius`), Bharat (`bharat`), Indus (`indus`), Bolly (`bolly`), Kuro (`kuro`), Quantum (`quantum`), Rousav (`rousav`), Quasar (`quasar`) |
| Sniper (5) | Atlas (`atlas`), Ursa (`ursa`), Andromeda (`andromeda`), Centaurus (`centaurus`), Daedalus (`daedalus`) |
| ZXC (6) | Valstrax (`valstrax`), Alatreon (`alatreon`), Resshin (`resshin`), Pulse (`zxc_pulse`), Vortex (`zxc_atlas`), Apex (`zxc_ursa`) |
| Hybrid (9) | Zenith (`zenith`), Nebula (`nebula`), Hyperion (`hyperion`), Flash (`vidfast`), Prism (`vaplayer`), Kronos (`kronos`), Pegasus (`pegasus`), Nova (`nova`), Apollo (`apollo`) |

Source: `https://embed.aethoflix.live/api/scan?tmdbId=93405&mediaType=tv&season=1&episode=1`. A scan's online/audio claims are not playback verification.

## Per-label results

GitHub Actions run [42225504292](https://github.com/themithology/Elfura/actions/runs/42225504292) separately requested every one of the 31 IDs for Dune: Part Two (movie `693134`) and TV `93405` season 1 episode 1. All 62 requests returned three entries per requested label, labelled English only. In **each individual response**, all 31 buckets contained the exact same three opaque relay URLs; no additional stream was found by choosing a different bucket inside that response.

For the TV sample, the three URLs were identical across all 31 requests as well. For the movie, 30 requests returned the same three URLs and Apollo returned another set of three; however the URLs contain opaque values that can change between requests, so that difference does **not** establish that Apollo has distinct upstream video. The API response contains Aethoflix edge URLs, not identifiable direct upstream URLs. Three URLs are not necessarily three different videos or working sources. These are observations for two titles on one run, not proof of global duplication or absence of Hindi elsewhere.

Earlier six-title matrix [42218343337](https://github.com/themithology/Elfura/actions/runs/42218343337) was intermittent: TV `93405` had 31 buckets / 93 entries / three distinct opaque URLs; two TV titles had no sources, and other samples timed out. Probed segment requests failed or timed out. Actual Aethoflix player browser audit [42218570082](https://github.com/themithology/Elfura/actions/runs/42218570082) did not establish sustained playback: one TV sample started at 22.9 seconds but advanced only 1.46 seconds during observation; one movie did not start and Dune timed out.

## Earlier client definition hints

The older public client inspected in [42129677823](https://github.com/themithology/Elfura/actions/runs/42129677823) explicitly mapped Orion, Indus and Rousav to VidBolt `orion`; Vega and Bharat to `vega`; Callisto, Bolly and Kuro to `callisto`. It also grouped several hybrid aliases by similarly named lanes. These are historical client definitions, not proof that the current server actually routes those labels separately. The fresh client inspection timed out, so the current routing of Sirius and Pulse could not be independently checked.

## Direct-upstream multi-audio prospects

* **VidBolt Orion/Rousav:** already in Elfura; browser research demonstrated native Hindi/English switching for movie `872585` and other title tests. Track labels and buffered audio are evidence of switching, not independently verified spoken language, correct content for every title, or sustained availability. This is one known family, not three independent providers.
* **VidBolt Vega / Quantum / Callisto / Quasar:** [direct lane audit 42121621788](https://github.com/themithology/Elfura/actions/runs/42121621788) found playable media bytes on some Vega results but no selectable audio renditions in sampled manifests; Quantum was mixed, Callisto and Quasar mostly empty, and later requests were rate-limited. These are leads, not verified new multi-audio sources. Re-test directly across more titles and in the browser before considering them.
* **Sniper and hybrid:** the advertised family names and opaque Aethoflix relay URLs do not identify a usable independent origin. Investigate direct upstream implementations and test actual track switching and correct titles; do not add the relay.
* **ZXC:** advertised family has six labels; a direct equivalent to the no-ZXC-mirror constraint has not been established. Previously observed rate limiting. Do not add the mirror.

## Integration rule

Add a direct candidate only when there is credible evidence of separate selectable audio tracks, with Hindi prioritized, correct title identity, and real browser playback. Test recovery and startup impact; cap single-language fallbacks at 1–2. Preserve the earlier exclusions and no-Aethoflix/no-ZXC-mirror rule. No additional multilingual provider is established by this inventory alone.

## Direct lane retest

Run [42225986780](https://github.com/themithology/Elfura/actions/runs/42225986780) queried Vega, Sirius, Callisto, Quantum and Quasar for eight movie/TV cases, including TV `215072` S2E2 and movie `807`. Sirius returned the **Orion** family for five cases, Vega for two and Quantum for one; it is not evidence of a new independent provider. The sampled Vega and Quantum streams had no alternate audio renditions; Callisto and Quasar returned no candidates. The Orion results included Hindi-labelled renditions in five cases, but playback, audible language and title accuracy were not validated by this manifest-and-byte audit. Do not count provider fallbacks or separate single-track files as additional multi-audio sources.

## Experimental additional HLS fallback

Source 4 uses Bingr's watch-page API and may return HLS via shared upstreams or a third-party bridge; it is not an independent provider guarantee. Hindi-labelled separate streams are kept distinct from manifest-verified alternate audio. Set `ELFURA_BINGR_ENABLED=0` in the backend environment to disable it independently. It uses a bounded startup race, with late results cached for recovery. Upstream availability, title correctness and complete playback remain unverified by a manifest probe alone.

Source 5 is the experimental Nxsha-backed Nitro/Indian-dub HLS adapter; it excludes the rejected Vidara provider and does not treat language labels as multi-audio evidence. It races alongside existing sources; set `ELFURA_NXSHA_ENABLED=0` to disable it. Availability and title matching are not guaranteed.
