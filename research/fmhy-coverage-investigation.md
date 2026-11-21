# FMHY coverage investigation

This is research, not a production-source registration. Browser tests that use
an injected adapter temporarily replace `source-28` **only inside the test
process**; they do not change the existing Source 28 anime adapter. All samples
use fixture TMDB metadata. Unless otherwise noted, video/audio and a five-minute
seek were checked in a GitHub Actions Chromium runner. Counts are a snapshot,
not a reliability guarantee. The workflows report sample failures in notices;
a successful workflow conclusion means the survey completed, not that every
sample played.

## Atlantic Vidbox lane

- The [initial manifest survey](https://github.com/themithology/Elfura/actions/runs/44896979711)
  found a reachable manifest for 9/10 tested real titles/episodes. An invalid
  episode returned no candidate. The other Atlantic lane was reachable for
  only one of those ten samples.
- With an injected adapter and **real authenticated playback endpoint and
  relay**, [12/13 samples](https://github.com/themithology/Elfura/actions/runs/44897783278)
  decoded video and non-silent audio and sought to five minutes. Casablanca had
  no candidate. No request to a candidate manifest hostname was observed from
  the browser in that run; this is not a comprehensive leakage audit.
- A broader [repeat](https://github.com/themithology/Elfura/actions/runs/44898933556)
  passed 16/23, with audio measured after the seek. Jaws, Dangal, The Simpsons
  S10E1 and Casablanca had a playback API 404; Titanic, The Dark Knight and
  3 Idiots received playback API 200 but did not start within the deadline.
  A separate [diagnostic](https://github.com/themithology/Elfura/actions/runs/44898972301)
  saw 404 for four selected samples, including some that had previously
  resolved; the upstream and registry cause is not yet isolated.
- [Reference frame comparisons](https://github.com/themithology/Elfura/actions/runs/44898098555)
  produced grayscale correlations of 0.997 and 0.973 for selected Game of
  Thrones S1E1 and S1E2 frames against Source 14; Fight Club and Naruto S1E1
  were not similarly confirmed by this limited sampling. This comparison does
  not establish the independent identity of the reference, or ownership.
- In sampled resolutions the candidate manifest host and exact URL differed
  from the raw candidates of Sources 1 and 14. The [URL-shape survey](https://github.com/themithology/Elfura/actions/runs/44898281164)
  indicates a proxy path, however, so a shared upstream or third-party relay
  dependency remains possible. Do not count hostname difference as proof of
  independence or bypass that proxy without a separate security review.

## Comparable existing sources

In a [same-corpus real-endpoint comparison](https://github.com/themithology/Elfura/actions/runs/44899440394),
Sources 1 and 14 each passed 18/23. These were separate runner jobs, not a
longitudinal or geographical reliability study. Source 14's first selected
streams for 3 Idiots and Dangal were roughly ten minutes long instead of full
movies, and failed the test's runtime criterion. The registry currently permits
wrong-runtime streams as a last-resort rail; do not claim that a source returned
the correct title merely because it had frames or a reachable playlist.

## Other candidates

- MovieNerds' API echoed the requested identity even for nonexistent media.
  Its reachable movie streams in the limited probe frequently shared a host
  with Source 14. After excluding known Source 14 host families, its first
  selections [played 0/9](https://github.com/themithology/Elfura/actions/runs/44898437133).
  A [three-title follow-up](https://github.com/themithology/Elfura/actions/runs/44898933595)
  observed manifest or fragment network errors; header and candidate selection
  issues remain possible. This does not prove every lane is unusable.
- Cinecat's Aphrodite lane returned the same silent 64-second video for ten
  sampled requests despite live manifests; its other tested routes returned
  401 or 429. FlyStream and Movy access probes returned 403 on that runner.
- Cineruv's tested API returned 403 for all requests. This result may depend on
  request configuration and region.

## Source 4 compatibility

[Player diagnostics](https://github.com/themithology/Elfura/actions/runs/44897186074)
showed that the source was selected and the manifest reached the browser, but
hls.js reported `manifestIncompatibleCodecsError`. The relayed playlists
advertised HEVC; a [raw manifest survey](https://github.com/themithology/Elfura/actions/runs/44899741006)
found an HEVC hint in every valid manifest checked across three samples, with no
explicit AVC declaration. The Chromium runner's inability to play those
selections must not be generalized to HEVC-capable devices, and it does not
alone justify changing the relay or removing a source.

## Remaining work

No two new, broadly reliable and independently operated sources have been
verified. Continue searching for independent direct-media backends, verify
multiple movies and episodes including negative and later-season cases, and
compare with the existing groups. Test over time and across deployment regions,
inspect true dependency overlap and applicable licenses, and confirm content
identity independently. Before production registration, add bounded parsing,
URL/redirect and SSRF protections, backend-only tickets and automated tests;
validate the actual resolver split, user-facing selection and deployment bundle.
