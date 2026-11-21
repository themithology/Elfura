# Anime sub/dub research

Status: **not a complete new source**. Do not register the experimental adapter or assert that every title has a dub or subtitles based on these checks.

## Existing multi-audio source (Source 28)

- Source 28 already maps TMDB show metadata to an AnimeSalt candidate, conservatively limited to season 1 and an exact episode-title match.
- [Real-player test](https://github.com/themithology/Elfura/actions/runs/44901067798): Naruto and Jujutsu Kaisen season 1 episodes 1 and 2 decoded video and non-silent audio while switching `ja → en → ja`. This tests the manifest track selection and playback, not independent recognition of the spoken language or the episode's identity. Metadata used in the test is a fixture.
- Each sample exposed zero subtitle tracks in that test. It is not known whether subtitles are burned in. Existing separately configured OpenSubtitles fallback may supply subtitles, but that was not verified here and is not guaranteed.
- The [catalogue survey](https://github.com/themithology/Elfura/actions/runs/44901402391) found playable-looking HLS candidates for Jujutsu Kaisen, My Hero Academia and Chainsaw Man. Some other searches failed or did not pass the conservative episode-title match. The survey uses TVMaze titles rather than genuine TMDB metadata; it is not a quantitative coverage estimate.

## Separate-stream candidate (Mikaza)

- The [discovery survey](https://github.com/themithology/Elfura/actions/runs/44901035007) used the existing TMDB→AniList mapping and tested five shows. English and Japanese requests returned distinct live URLs declared by the service as `dub` and `sub`, respectively. Those claims do not independently establish spoken language, episode identity, subtitle presence or availability for later seasons. No separate subtitle tracks were returned.
- The research-only injected prototype in `backend/test/anime-mikaza-ja-en-browser.mjs` is not registered in production. The [six-sample player test](https://github.com/themithology/Elfura/actions/runs/44901378830) did not pass the `ja → en → ja` switching check. In a [diagnostic](https://github.com/themithology/Elfura/actions/runs/44901750379) the first Japanese selection briefly reported success, but playback later ended up on an English source with a media network error. This does not prove a single cause. Separate-stream switching, media liveness, mapping and subtitles all need further investigation before promotion.
- AniList mapping currently has a known season/sequel ambiguity; do not assume TMDB season and episode numbers always match an AniList entry.

## Audio language verification

A repeatable optional automatic language diagnostic uses short ephemeral audio captured from the real player. It does not retain clips or transcripts, and detection is only supporting evidence: music, silence and multilingual speech can mislead it. Initial attempts failed due to a faster-whisper/PyAV API incompatibility; the research script decodes via ffmpeg instead. In the [corrected run](https://github.com/themithology/Elfura/actions/runs/44902154579), captured episode 1 English and Japanese tracks were classified as English and Japanese for both Naruto (0.953 and 0.983) and Jujutsu Kaisen (0.988 and 0.992). These are estimates from two short samples per show, not verification of entire tracks or of subtitles.
