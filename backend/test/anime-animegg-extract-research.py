"""Prepare ephemeral provider results for browser research; never print URLs."""
import asyncio
import contextlib
import io
import json
import os
import sys

import httpx
sys.path.insert(0, sys.argv[1])
from src.providers._media import build_ctx
from src.providers.animegg import watch

SAMPLES = [('46260', 'Naruto'), ('95479', 'Jujutsu Kaisen'), ('1429', 'Attack on Titan')]

async def main():
    output = {}
    async with httpx.AsyncClient(timeout=15) as client:
        for tmdb, title in SAMPLES:
            try:
                response = await client.get('https://api.ani.zip/mappings', params={'themoviedb_id': tmdb})
                response.raise_for_status()
                aid = int(response.json()['mappings']['anilist_id'])
                ctx = await asyncio.wait_for(build_ctx(aid), 30)
                for lang in ('sub', 'dub'):
                    try:
                        results = await asyncio.wait_for(watch(aid, lang, 1, ctx), 60)
                        valid = [s for s in results if s.get('type') == 'mp4' and s.get('audio') == lang and isinstance(s.get('url'), str)]
                        if valid:
                            output[f'{tmdb}-{lang}'] = {'url': valid[0]['url'], 'referer': valid[0].get('referer', '')}
                    except Exception:
                        pass
            except Exception:
                pass
    with open(os.environ['RESEARCH_STREAM_FILE'], 'w') as handle:
        json.dump(output, handle)
    return {'candidates': sorted(output), 'count': len(output)}

with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    report = asyncio.run(main())
print('::notice title=Anime candidate extraction::' + json.dumps(report, separators=(',', ':')))
