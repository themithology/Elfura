# AniVortex live probe report

Run: 43688607451 on arena/399224d8-elfura at 2026-11-15T07:08:55Z

```
No ELFURA_ANIVORTEX_* credentials present — registering a throwaway installation.
Registration succeeded (installation_id length=36, key_id length=36).

=== movie: Dune: Part Two (2024)
  search /api/v1/search?q= → HTTP 200 in 139ms object{query,items}
  first item keys: object{id,title,original_title,content_type,release_year,rating,poster_url,backdrop_url,audio_badge,newly_added}
  first three: Dune: Part Two (2024) [movie] id=1741 | Dune: Part One (2021) [movie] id=1740 | Ponniyin Selvan: Part Two (2023) [movie] id=5135
  matched title id: 1741 (Dune: Part Two)
  detail /api/v1/titles/1741 → HTTP 200 in 140ms object{id,title,original_title,content_type,release_year,rating,votes_label,overview,poster_url,backdrop_url,country,genres}
  detail keys: object{id,title,original_title,content_type,release_year,rating,votes_label,overview,poster_url,backdrop_url,country,genres}
    content_type="movie"
  playback /api/v1/titles/1741/playback? → HTTP 200 in 792ms object{title_id,episode,selected_server_key,server_options,server,server_status,navigation}
  server_options=2: ok_video,moviebox_web
  server=ok_video languages=3
    lang=en/English qualities=0
    lang=hi/Hindi qualities=0
    lang=und/Unknown qualities=0

=== tv: Breaking Bad (2008)
  search /api/v1/search?q= → HTTP 200 in 134ms object{query,items}
  first item keys: object{id,title,original_title,content_type,release_year,rating,poster_url,backdrop_url,audio_badge,newly_added}
  first three: Breaking Bad (2008) [series] id=123 | No Breathing (2013) [movie] id=829
  matched title id: 123 (Breaking Bad)
  detail /api/v1/titles/123 → HTTP 200 in 132ms object{id,title,original_title,content_type,release_year,rating,votes_label,overview,poster_url,backdrop_url,country,genres}
  detail keys: object{id,title,original_title,content_type,release_year,rating,votes_label,overview,poster_url,backdrop_url,country,genres}
    content_type="series"
  watch /api/v1/titles/123/watch → HTTP 200 in 121ms object{title,default_server_key,seasons,available_servers,recommendations,resume_progress}
  playback /api/v1/titles/123/playback?season=1&episode=1 → HTTP 400 in 128ms object{error} error=invalid_query:only episode_id, include_adult, server, and language are supported
  playback /api/v1/titles/123/playback? → HTTP 400 in 138ms object{error} error=episode_required:episode_id is required for this title
  playback /api/v1/titles/123/playback?episode=1 → HTTP 400 in 121ms object{error} error=invalid_query:only episode_id, include_adult, server, and language are supported

=== movie: Oppenheimer (2023)
  search /api/v1/search?q= → HTTP 200 in 143ms object{query,items}
  first item keys: object{id,title,original_title,content_type,release_year,rating,poster_url,backdrop_url,audio_badge,newly_added}
  first three: Oppenheimer (2023) [movie] id=215
  matched title id: 215 (Oppenheimer)
  detail /api/v1/titles/215 → HTTP 200 in 142ms object{id,title,original_title,content_type,release_year,rating,votes_label,overview,poster_url,backdrop_url,country,genres}
  detail keys: object{id,title,original_title,content_type,release_year,rating,votes_label,overview,poster_url,backdrop_url,country,genres}
    content_type="movie"
  playback /api/v1/titles/215/playback? → HTTP 200 in 640ms object{title_id,episode,selected_server_key,server_options,server,server_status,navigation}
  server_options=1: ok_video
  server=ok_video languages=2
    lang=en/English qualities=0
    lang=hi/Hindi qualities=0
```
