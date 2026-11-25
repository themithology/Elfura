# Is it a new source, or the same pipe?

Measured 2026-11-25T13:16:18.429Z. Raw rows in [independence.json](independence.json).

A candidate is independent when **none of the hosts behind its media** — the URL it
hands out, the child playlists, the segments, the key URIs — appear in the media
hosts behind the approved sources. A shared host is a shared dependency, however
different the URL looks.

## The board, as measured

| source | media hosts |
| --- | --- |
| source-1 | `img1.hscow.com`, `img.hscow.com` |
| source-2 | `greyboxtv.duckdns.org` |
| source-3 | _none_ |
| source-4 | `img.rousav.tech`, `gzip.rousav.tech` |

## Candidates

| candidate | playable | hosts | shared with board | verdict |
| --- | --- | --- | --- | --- |
| atlantic-vidbox | no | 0 | — | no media at all — not a source yet |
| atlantic-q62 | no | 1 | — | media found but no bytes (http=429, http=429) |

## Why a lane produced nothing

| lane / title | what arrived |
| --- | --- |
| atlantic-vidbox:fight-club | status 200; top-level keys [sources]; sources keys [Tik] |
| atlantic-vidbox:inception | status 200; top-level keys [sources]; sources keys [Tik] |
| atlantic-vidbox:got-s1e1 | status 200; top-level keys [sources]; sources keys [Tik] |
| atlantic-vidbox:naruto-s1e1 | status 200; top-level keys [sources]; sources keys [Tik] |

