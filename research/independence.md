# Is it a new source, or the same pipe?

Measured 2026-11-25T12:26:02.936Z. Raw rows in [independence.json](independence.json).

A candidate is independent when **none of the hosts behind its media** — the URL it
hands out, the child playlists, the segments, the key URIs — appear in the media
hosts behind the approved sources. A shared host is a shared dependency, however
different the URL looks.

## The board, as measured

| source | media hosts |
| --- | --- |
| source-1 | `img1.hscow.com`, `img.hscow.com`, `img1.fcxmb.com`, `img.fcxmb.com` |
| source-2 | `greyboxtv.duckdns.org` |
| source-3 | `wts.itsnitrox.tech`, `silent-frost-f2dbv.nxstreamhub.workers.dev`, `s14-s1001604.97bf1.com` |

## Candidates

| candidate | playable | hosts | shared with board | verdict |
| --- | --- | --- | --- | --- |
| atlantic-vidbox | no | 0 | — | no media at all — not a source yet |
| atlantic-q62 | yes, 262144B | 1 | — | independent of the board; RELAY-SHAPED host(s): proxy.7movie.ws — the board refuses relay fronts |

## Why a lane produced nothing

| lane / title | what arrived |
| --- | --- |
| atlantic-vidbox:fight-club | status 502; top-level keys [type, title, status, detail, instance, error_code, error_name, error_category]; sources keys [] |
| atlantic-vidbox:inception | status 502; top-level keys [type, title, status, detail, instance, error_code, error_name, error_category]; sources keys [] |
| atlantic-vidbox:got-s1e1 | status 502; top-level keys [type, title, status, detail, instance, error_code, error_name, error_category]; sources keys [] |
| atlantic-vidbox:naruto-s1e1 | status 502; top-level keys [type, title, status, detail, instance, error_code, error_name, error_category]; sources keys [] |
| atlantic-q62:got-s1e1 | status 404; top-level keys [detail, error] |
| atlantic-q62:naruto-s1e1 | status 404; top-level keys [detail, error] |

