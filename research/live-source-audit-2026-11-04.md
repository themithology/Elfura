# Live source audit — 2026-11-04

This audit checks title-specific resolution and, when a provider returns options, follows manifests/playlists and fetches recognizable media bytes through Elfura's normal relay. A green workflow is not treated as a provider pass: the matrix permits 404/unavailable cases, and a provider with zero options cannot pass playback verification.

## Expanded 21-title matrix — run 43622324362

This is the latest audit snapshot; exact per-title/per-source outcomes are recorded in [`live-source-coverage-43622324362.csv`](live-source-coverage-43622324362.csv) and the [GitHub Actions run](https://github.com/themithology/Elfura/actions/runs/43622324362). `PASS` means every advertised option for that source/title passed manifest and recognizable-media-byte checks. `FAIL` means at least one advertised option failed those checks (it does not imply every option failed). `UNAVAILABLE` means the source returned no match for that title; it is not evidence of a universal outage. The `combined` column is populated only for the five titles that explicitly tested the combined path.

| ID | PASS | FAIL | UNAVAILABLE | Details |
|---|---:|---:|---:|---|
| 1 | 11 | 0 | 10 | Passed on Avengers: Infinity War, Oppenheimer, Spider-Verse, Inception, Stranger Things S1E1, John Wick: Chapter 4, Dune: Part Two, Interstellar, Avengers: Endgame, Breaking Bad S1E1, and Game of Thrones S1E1. |
| 2 | 18 | 0 | 3 | 18 title-specific passes; see CSV for exact titles. |
| 4 | 0 | 0 | 21 | Bingr returned no title matches in this matrix. |
| 5 | 0 | 0 | 21 | Nxsha returned no title matches in this matrix. |
| 7 | 0 | 0 | 21 | ScreenScape returned no title matches in this matrix. |
| 8 | 5 | 0 | 16 | Passed on John Wick: Chapter 4, Interstellar, Avengers: Endgame, Jujutsu Kaisen S1E1, and Frieren S1E1. |
| 9 | 0 | 0 | 21 | VixSrc returned no title matches in this matrix. |
| 10 | 0 | 4 | 17 | Four titles returned options with variant-media HTTP 403; no title had a clean all-options pass. This is a bad-option/provider delivery result, not the same as a 404 miss. |
| 11 | 0 | 0 | 21 | VAPlayer returned no title matches in this matrix. |
| 12 | 0 | 0 | 21 | VidZen returned no title matches in this run (earlier runs differed; provider results are time-sensitive). |
| 13 | 0 | 0 | 21 | Xpass returned no title matches in this matrix. |
| 14 | 16 | 0 | 5 | Passed on Avatar: The Way of Water, Avengers: Infinity War, The Batman, Oppenheimer, Spider-Verse, Inception, Stranger Things S1E1, John Wick: Chapter 4, Dune: Part Two, Interstellar, Pushpa: The Rise, Avengers: Endgame, Breaking Bad S1E1, Jujutsu Kaisen S1E1, Re:Zero S1E1, and Frieren S1E1. Existing unverified-title/language caveats still apply. |
| 15 | 0 | 0 | 21 | Mapple returned no title matches in this matrix. |
| 16 | 0 | 0 | 21 | Anivexa returned no title matches in this matrix. |
| 17 | 9 | 3 | 9 | Passed on Avatar: The Way of Water, Avengers: Infinity War, The Batman, Oppenheimer, Inception, Stranger Things S1E1, Breaking Bad S1E1, Game of Thrones S1E1, and One Piece S1E1. Jawan, Pushpa: The Rise, and Re:Zero had at least one variant request return HTTP 502. |

The five combined-path checks yielded four passes and one failure. Overall, 13/21 title jobs succeeded and 8 failed; those job-level results are not a source health score. The matrix shows that previous no-match-only samples understated coverage for Sources 2, 8, 14, and especially 17. Conversely, Sources 4, 5, 7, 9, 11, 13, 15, and 16 still have no playable pass in this 21-title sample. Keep these as evidence for follow-up, not automatic removal decisions: a title-specific 404 remains a miss, not proof that a provider is universally dead.

Source 10's repeated HTTP 403s and Source 17's HTTP 502s are now distinguished from title misses in the audit report. No adapter change or source removal was made on this evidence alone. Job summaries, title/source annotations, and raw per-title JSON artifacts are emitted by the updated coverage workflow so future runs retain the full option-level outcomes.

## Earlier sampled results (before the 21-title matrix)

| ID | Provider | Live result | Decision |
|---|---|---|---|
| 1 | VidBolt (shared adapter group) | Passed on Dune: Part Two, Oppenheimer, Interstellar, and Breaking Bad S1E1. HLS master/child playlists and media segments were fetched; manifests exposed 2–10 audio renditions on sampled titles. | Keep; verified on these samples. |
| 2 | VidRift/VidRock (shared adapter group) | Passed on Dune: Part Two and Oppenheimer. HLS manifests, init/media segments, and child playlists returned recognizable media bytes. | Keep; verified on these samples. |
| 3 | VidSync | No title match (404) for Dune: Part Two, Interstellar, and Breaking Bad S1E1 in isolated checks. A hosted trace also found the embed page (HTTP 200) but `/api/stream` returned zero sources at primary, secondary, fallback, and no-stage probes; session init returned 405. | Retired completely: removed from the runtime registry, configuration, Roxy inventory, adapter source, tests, research probes, and live workflow. This audit is the historical record. |
| 4 | Bingr | 404/no title match for Dune: Part Two and Jujutsu Kaisen S1E1. | No live pass; remains opt-in/disabled by default. Do not advertise as working. |
| 5 | Nxsha | 404/no title match for Dune: Part Two and Interstellar. | No live pass; remains opt-in/disabled by default. Do not advertise as working. |
| 6 | — | No Source 6 adapter is registered in the current registry. | Not applicable. |
| 7 | ScreenScape | 404/no title match for Interstellar and Breaking Bad S1E1. | No live pass; remains opt-in/disabled by default. Do not advertise as working. |
| 8 | VidZee | Resolved and returned recognizable media bytes for Interstellar, Jujutsu Kaisen S1E1, and Frieren S1E1. Also missed on Oppenheimer (earlier mislabeled Spider-Man: Across the Spider-Verse), Dune: Part Two, Breaking Bad S1E1, Death Note S1E1, and Re:Zero S1E1. Successful samples were leaf-HLS media-segment checks; no manifest audio-track evidence was returned. | Keep; live playable-byte evidence on three titles, with title-specific misses and limited audio evidence. |
| 9 | VixSrc | 404/no title match for Dune: Part Two and Interstellar. | No live pass; remains opt-in/disabled by default. Do not advertise as working. |
| 10 | VidNest | 404/no title match for Interstellar and Dune: Part Two. | No live pass; remains opt-in/disabled by default. Do not advertise as working. |
| 11 | VAPlayer | 404/no title match for Breaking Bad S1E1 and Re:Zero S1E1. | No live pass; remains opt-in/disabled by default. Do not advertise as working. |
| 12 | VidZen | 404/no title match for Jujutsu Kaisen S1E1 and Frieren S1E1. | No live pass; remains opt-in/disabled by default. Do not advertise as working. |
| 13 | Xpass | 404/no title match for Interstellar and Breaking Bad S1E1. | No live pass; remains opt-in/disabled by default. Do not advertise as working. |
| 14 | Rive Citadel | Returned candidates whose relayed media-byte requests succeeded for Dune: Part Two, Oppenheimer (earlier mislabeled Spider-Man: Across the Spider-Verse), Interstellar, Breaking Bad S1E1, Death Note S1E1, Frieren S1E1, and Re:Zero S1E1. Its output labels are explicitly marked unverified; these checks did not establish the content's title or spoken language, and did not expose manifest audio metadata. | Keep with the existing unverified-label caveat; byte reachability is not proof of correct title/audio. |
| 15 | Mapple | 404/no title match for Dune: Part Two and Oppenheimer (earlier mislabeled Spider-Man: Across the Spider-Verse). | No live pass; remains opt-in/disabled by default. Do not advertise as working. |
| 16 | Anivexa | 404/no title match for Jujutsu Kaisen S1E1 and Frieren S1E1. | No live pass; remains opt-in/disabled by default. Do not advertise as working. |
| 17 | Stremio add-on bridge (Nuvio Streams) | Source-isolated Dune: Part Two check returned 720p and 1080p HLS options; manifests, init/media segments, and variant playlists yielded recognizable bytes. | Keep; verified on this sample. |
| 18 | Embed69 | Repeated prior checks returned 404/no title match; removed earlier. | Remains removed. |

## Evidence and limits

- **Sample correction:** Earlier workflow rows labeled TMDB `872585` as Spider-Man: Across the Spider-Verse. That ID is Oppenheimer; Spider-Verse is TMDB `569094`. The earlier media observations are retained under the corrected title above. The expanded matrix uses `569094` for Spider-Verse and tests both titles separately.
- Expanded first-round matrix: [Actions run 43562065709](https://github.com/themithology/Elfura/actions/runs/43562065709).
- Alternate-title matrix: [Actions run 43562303725](https://github.com/themithology/Elfura/actions/runs/43562303725). This run's overall conclusion was **failure** because isolated providers returned no options; the completed CI job is not a pass for those providers.
- Post-retirement active-source regression matrix: [Actions run 43562991283](https://github.com/themithology/Elfura/actions/runs/43562991283) completed successfully. Its annotations still show provider-level title misses (for example VidZee on Dune) under the workflow's unavailable-allowed policy; the green workflow is not an assertion that every provider worked on every title.
- VidSync API trace: [Actions run 43561839066](https://github.com/themithology/Elfura/actions/runs/43561839066).
- A 404 means that provider did not resolve that particular title; it is not proof of a universal outage. Sources 4, 5, 7, and 9–13, 15–16 are already disabled by default and remain experimental. They have no passing live samples in this audit and must not be described as working.
- Media-byte checks establish that bytes resembling media were served, not that the video/audio was watched or matched the requested title. This limitation is especially important for Source 14's unverified labels.
