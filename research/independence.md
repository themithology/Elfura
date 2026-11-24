# Is it a new source, or the same pipe?

Measured 2026-11-24T18:00:16.796Z. Raw rows in [independence.json](independence.json).

A candidate is independent when **none of the hosts behind its media** — the URL it
hands out, the child playlists, the segments, the key URIs — appear in the media
hosts behind the approved sources. A shared host is a shared dependency, however
different the URL looks.

## The board, as measured

| source | media hosts |
| --- | --- |
| source-1 | `img1.hscow.com`, `img.hscow.com` |
| source-2 | `greyboxtv.duckdns.org` |

## Candidates

| candidate | playable | hosts | shared with board | verdict |
| --- | --- | --- | --- | --- |
| atlantic-vidbox | no | 0 | — | no media at all — not a source yet |
| atlantic-q62 | yes, 262144B | 1 | — | INDEPENDENT — no media host shared with any approved source |

