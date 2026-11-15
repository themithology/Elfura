# AniVortex live probe report

Run: 43689611144 on arena/399224d8-elfura at 2026-11-15T07:22:12Z

```
No ELFURA_ANIVORTEX_* credentials present — registering a throwaway installation.
Registration succeeded (installation_id length=36, key_id length=36).

=== movie: Dune: Part Two (2024)
  search /api/v1/search?q= → HTTP 200 in 145ms object{query,items}
  first item keys: object{id,title,original_title,content_type,release_year,rating,poster_url,backdrop_url,audio_badge,newly_added}
  first three: Dune: Part Two (2024) [movie] id=1741 | Dune: Part One (2021) [movie] id=1740 | Ponniyin Selvan: Part Two (2023) [movie] id=5135
  matched title id: 1741 (Dune: Part Two)
  detail /api/v1/titles/1741 → HTTP 200 in 144ms object{id,title,original_title,content_type,release_year,rating,votes_label,overview,poster_url,backdrop_url,country,genres}
  detail keys: object{id,title,original_title,content_type,release_year,rating,votes_label,overview,poster_url,backdrop_url,country,genres}
    content_type="movie"
  playback /api/v1/titles/1741/playback? → HTTP 200 in 792ms object{title_id,episode,selected_server_key,server_options,server,server_status,navigation}
  server_options=2: ok_video,moviebox_web
  server=ok_video languages=3
    language dump: {"code":"en","name":"English","playback":{"quality_mode":"adaptive","sources":[{"id":"ok-16860379876060-dash","quality":"Auto","format":"dash","url":"https://vd750.okcdn.ru/…","fallback_urls":["…","…"],"headers":{"user-agent":"…"},"expires_at":"2026-11-15T09:22:02.516223373Z","file_size_bytes":null}]},"download_options":[{"id":"ok-16860379876060-full","quality":"1080p","format":"mp4","url":"https://ok6-13.vkuser.net/…","fallback_urls":["https://vd750.okcdn.ru/…","https://vd639.okcdn.ru/…"],"headers":{"user-agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E1"},"expires_at":"2026-11-15T09:22:02.516223373Z","file_size_bytes":null}]}
    lang=en/English qualities=0
    language dump: {"code":"hi","name":"Hindi","playback":{"quality_mode":"adaptive","sources":[{"id":"ok-16860379810524-dash","quality":"Auto","format":"dash","url":"https://vd748.okcdn.ru/…","fallback_urls":["…","…"],"headers":{"user-agent":"…"},"expires_at":"2026-11-15T09:22:02.516223373Z","file_size_bytes":null}]},"download_options":[{"id":"ok-16860379810524-full","quality":"1080p","format":"mp4","url":"https://ok6-3.vkuser.net/…","fallback_urls":["https://vd748.okcdn.ru/…","https://vd668.okcdn.ru/…"],"headers":{"user-agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E1"},"expires_at":"2026-11-15T09:22:02.516223373Z","file_size_bytes":null}]}
    lang=hi/Hindi qualities=0

=== tv: Breaking Bad (2008)
  search /api/v1/search?q= → HTTP 200 in 129ms object{query,items}
  first item keys: object{id,title,original_title,content_type,release_year,rating,poster_url,backdrop_url,audio_badge,newly_added}
  first three: Breaking Bad (2008) [series] id=123 | No Breathing (2013) [movie] id=829
  matched title id: 123 (Breaking Bad)
  detail /api/v1/titles/123 → HTTP 200 in 134ms object{id,title,original_title,content_type,release_year,rating,votes_label,overview,poster_url,backdrop_url,country,genres}
  detail keys: object{id,title,original_title,content_type,release_year,rating,votes_label,overview,poster_url,backdrop_url,country,genres}
    content_type="series"
  watch /api/v1/titles/123/watch → HTTP 200 in 135ms object{title,default_server_key,seasons,available_servers,recommendations,resume_progress}
  season[0] keys: object{id,season_number,episode_count}
  season[0] dump: {"id":183,"season_number":1,"episode_count":7}
  available_servers: 
  episodes /api/v1/seasons/183/episodes → HTTP 200 in 126ms object{season_id,episodes,next_cursor,has_more}
    first episode: {"id":1567,"season_id":183,"season_number":1,"episode_number":1,"title":"Pilot","description":"After being diagnosed with terminal lung cancer, a struggling high school chemistry teacher makes a drastic choice to se","thumbnail_url":"https://m.media-amazon.com/…","available_servers":[{"key":"moviebox_web","name":"Spiral","downloads_enabled":true}],"progress":null}
  episodes /api/v1/seasons/183 → HTTP 404 in 134ms null
  episodes /api/v1/titles/123/episodes → HTTP 404 in 138ms null
  episodes /api/v1/titles/123/watch?season=1 → HTTP 400 in 122ms object{error} error=invalid_query:only include_adult is supported
  playback /api/v1/titles/123/playback?season=1&episode=1 → HTTP 400 in 132ms object{error} error=invalid_query:only episode_id, include_adult, server, and language are supported
  playback /api/v1/titles/123/playback? → HTTP 400 in 132ms object{error} error=episode_required:episode_id is required for this title
  playback /api/v1/titles/123/playback?episode=1 → HTTP 400 in 141ms object{error} error=invalid_query:only episode_id, include_adult, server, and language are supported

=== movie: Oppenheimer (2023)
  search /api/v1/search?q= → HTTP 200 in 128ms object{query,items}
  first item keys: object{id,title,original_title,content_type,release_year,rating,poster_url,backdrop_url,audio_badge,newly_added}
  first three: Oppenheimer (2023) [movie] id=215
  matched title id: 215 (Oppenheimer)
  detail /api/v1/titles/215 → HTTP 200 in 135ms object{id,title,original_title,content_type,release_year,rating,votes_label,overview,poster_url,backdrop_url,country,genres}
  detail keys: object{id,title,original_title,content_type,release_year,rating,votes_label,overview,poster_url,backdrop_url,country,genres}
    content_type="movie"
  playback /api/v1/titles/215/playback? → HTTP 200 in 660ms object{title_id,episode,selected_server_key,server_options,server,server_status,navigation}
  server_options=1: ok_video
  server=ok_video languages=2
    language dump: {"code":"en","name":"English","playback":{"quality_mode":"adaptive","sources":[{"id":"ok-16281651841756-dash","quality":"Auto","format":"dash","url":"https://ok6-12.vkuser.net/…","fallback_urls":["…","…"],"headers":{"user-agent":"…"},"expires_at":"2026-11-15T09:22:04.895735904Z","file_size_bytes":null}]},"download_options":[{"id":"ok-16281651841756-ultra","quality":"4K","format":"mp4","url":"https://ok6-12.vkuser.net/…","fallback_urls":["https://vd516.okcdn.ru/…","https://vd652.okcdn.ru/…"],"headers":{"user-agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E1"},"expires_at":"2026-11-15T09:22:04.895735904Z","file_size_bytes":null},{"id":"ok-16281651841756-quad","quality":"2K","format":"mp4","url":"https://ok6-12.vkuser.net/…","fallback_urls":["https://vd516.okcdn.ru/…","https://vd652.okcdn.ru/…"],"headers":{"user-agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E1"},"expires_at":"2026-11-15T09:22:04.895735904Z","file_size_bytes":null},{"id":"ok-16281651841756-full","quality":"1080p","format":"mp4","url":"https://ok6-12.vkuser.net/…","fallback_urls":["https://vd516.okcdn.ru/…","https://vd652.okcdn.ru/…"],"headers":{"user-agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E1"},"expires_at":"2026-11-15T09:22:04.895735904Z","file_size_bytes":null}]}
    lang=en/English qualities=0
    language dump: {"code":"hi","name":"Hindi","playback":{"quality_mode":"adaptive","sources":[{"id":"ok-16281651645148-dash","quality":"Auto","format":"dash","url":"https://ok6-4.vkuser.net/…","fallback_urls":["…","…"],"headers":{"user-agent":"…"},"expires_at":"2026-11-15T09:22:04.895735904Z","file_size_bytes":null}]},"download_options":[{"id":"ok-16281651645148-ultra","quality":"4K","format":"mp4","url":"https://ok6-4.vkuser.net/…","fallback_urls":["https://vd419.okcdn.ru/…","https://vd673.okcdn.ru/…"],"headers":{"user-agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E1"},"expires_at":"2026-11-15T09:22:04.895735904Z","file_size_bytes":null},{"id":"ok-16281651645148-quad","quality":"2K","format":"mp4","url":"https://ok6-4.vkuser.net/…","fallback_urls":["https://vd419.okcdn.ru/…","https://vd673.okcdn.ru/…"],"headers":{"user-agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E1"},"expires_at":"2026-11-15T09:22:04.895735904Z","file_size_bytes":null},{"id":"ok-16281651645148-full","quality":"1080p","format":"mp4","url":"https://ok6-4.vkuser.net/…","fallback_urls":["https://vd419.okcdn.ru/…","https://vd673.okcdn.ru/…"],"headers":{"user-agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E1"},"expires_at":"2026-11-15T09:22:04.895735904Z","file_size_bytes":null}]}
    lang=hi/Hindi qualities=0

=== adapter + liveness (Source 17 as Elfura would run it)
  movie "Dune: Part Two" → rows=9 manifestReachable=6 in 4080ms
    types=dash audioRows={"en":3,"hi":3,"und":2,"te":1}
    DEAD dash en https://sbcdnw.hakunaymatata.com/…
      as-provided: HTTP 426 type=text/html body="426 Forbidden "
      referer-moviebox: HTTP 426 type=text/html body="426 Forbidden "
      referer-api: HTTP 429 type=text/html body="<html> <head><title>429 Too Many Requests</title></head> <"
      iphone-ua: HTTP 426 type=text/html body="426 Forbidden "
      range-zero: HTTP 426 type=text/html body="426 Forbidden "
    DEAD dash hi https://sbcdnw.hakunaymatata.com/…
      as-provided: HTTP 426 type=text/html body="426 Forbidden "
      referer-moviebox: HTTP 426 type=text/html body="426 Forbidden "
      referer-api: HTTP 429 type=text/html body="<html> <head><title>429 Too Many Requests</title></head> <"
      iphone-ua: HTTP 426 type=text/html body="426 Forbidden "
      range-zero: HTTP 426 type=text/html body="426 Forbidden "
    alive dash en https://vd750.okcdn.ru/… manifest=dash audioRenditions=0 langs=[]
    alive dash hi https://vd748.okcdn.ru/… manifest=dash audioRenditions=0 langs=[]
    alive dash und https://vd449.okcdn.ru/… manifest=dash audioRenditions=0 langs=[]
    alive dash en https://vd750.okcdn.ru/… manifest=dash audioRenditions=0 langs=[]
  tv "Breaking Bad" → rows=2 manifestReachable=0 in 923ms
    types=dash audioRows={"en":1,"hi":1}
    DEAD dash en https://sbcdnw.hakunaymatata.com/…
      as-provided: HTTP 426 type=text/html body="426 Forbidden "
      referer-moviebox: HTTP 426 type=text/html body="426 Forbidden "
      referer-api: HTTP 429 type=text/html body="<html> <head><title>429 Too Many Requests</title></head> <"
      iphone-ua: HTTP 426 type=text/html body="426 Forbidden "
      range-zero: HTTP 426 type=text/html body="426 Forbidden "
    DEAD dash hi https://sbcdnw.hakunaymatata.com/…
      as-provided: HTTP 426 type=text/html body="426 Forbidden "
      referer-moviebox: HTTP 426 type=text/html body="426 Forbidden "
      referer-api: HTTP 429 type=text/html body="<html> <head><title>429 Too Many Requests</title></head> <"
      iphone-ua: HTTP 426 type=text/html body="426 Forbidden "
      range-zero: HTTP 426 type=text/html body="426 Forbidden "
  movie "Oppenheimer" → rows=2 manifestReachable=2 in 1677ms
    types=dash audioRows={"en":1,"hi":1}
    alive dash en https://ok6-12.vkuser.net/… manifest=dash audioRenditions=0 langs=[]
    alive dash hi https://ok6-4.vkuser.net/… manifest=dash audioRenditions=0 langs=[]
```
