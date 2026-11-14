# Live source audit — 2026-11-04

This audit checks title-specific resolution and, when a provider returns options, follows manifests/playlists and fetches recognizable media bytes through Elfura's normal relay. A green workflow is not treated as a provider pass: the matrix permits 404/unavailable cases, and a provider with zero options cannot pass playback verification.

## Results in numeric order

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
