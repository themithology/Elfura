"""Count hard-sub server groups without disclosing provider URLs or payloads."""
import asyncio
import contextlib
import io
import json
import re
import sys
from urllib.parse import quote
import httpx
sys.path.insert(0, sys.argv[1])
from src.providers._media import build_ctx
from src.providers.anikoto import resolve_series, _data_attr, BASE
from src.providers._http import fetch_json

async def main():
    rows = []
    async with httpx.AsyncClient(timeout=15) as client:
        for title, tmdb in [('Naruto','46260'),('Jujutsu Kaisen','95479'),('Attack on Titan','1429'),('One Piece','37854'),('Demon Slayer','85937')]:
            row = {'title':title}
            try:
                r = await client.get('https://api.ani.zip/mappings', params={'themoviedb_id':tmdb})
                r.raise_for_status()
                aid = int(r.json()['mappings']['anilist_id'])
                ctx = await asyncio.wait_for(build_ctx(aid),30)
                series = await asyncio.wait_for(resolve_series(aid,ctx),45)
                ep = 1 + series['offset'] if series['mode']=='offset' else 1
                doc = await fetch_json(f"{BASE}/ajax/episode/list/{series['show_id']}", {'Referer': BASE+'/', 'X-Requested-With':'XMLHttpRequest'})
                tags = re.findall(r'<a\s+[^>]*data-id="[^"]*"[^>]*>', (doc.get('result') or ''), re.I)
                tag = next(t for t in tags if _data_attr(t,'num')==str(ep))
                ids = _data_attr(tag,'ids')
                servers = await fetch_json(f'{BASE}/ajax/server/list?servers={quote(ids,safe="")}', {'Referer': BASE+'/', 'X-Requested-With':'XMLHttpRequest'})
                html = servers.get('result') or ''
                groups = {}
                for match in re.finditer(r'<div class="type" data-type="([^"]+)">([\s\S]*?)</ul>\s*</div>',html,re.I):
                    typ = match.group(1)
                    if typ in ('sub','dub','hsub'):
                        groups[typ] = len(re.findall(r'<li\s+[^>]*data-link-id=',match.group(2),re.I))
                row['groups']=groups
            except Exception as exc:
                row['error']=type(exc).__name__
            rows.append(row)
    return rows

with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    result = asyncio.run(main())
for row in result:
    print('::notice title=Anime hard-sub catalogue sample::' + json.dumps(row,separators=(',',':')))
