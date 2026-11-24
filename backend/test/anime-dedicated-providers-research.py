"""Research-only independent provider survey. No streams or raw URLs are published.

Run in a disposable environment with the MIT-licensed Kuhi repository pinned by
its workflow. Counts provider results and basic HTTP liveness only: not proof of
playback, subtitle rendering, language, correct identity, or long-term reliability.
"""
import asyncio
import contextlib
import hashlib
import importlib
import io
import json
import re
import sys
from urllib.parse import urlsplit

import httpx

sys.path.insert(0, sys.argv[1])
from src.providers._media import build_ctx

SAMPLES = [('Naruto', '46260'), ('Jujutsu Kaisen', '95479'), ('Attack on Titan', '1429')]
PROVIDERS = ['anineko', 'anikoto', 'animegg', 'kaa']


def reason(exc):
    text = str(exc)
    status = re.search(r'\bHTTP (\d{3})\b', text)
    return 'HTTP ' + status.group(1) if status else type(exc).__name__


async def one(client, sem, provider, title, anilist, ctx, lang):
    row = {'title': title, 'provider': provider, 'requested': lang}
    async with sem:
        try:
            mod = importlib.import_module('src.providers.' + provider)
            streams = await asyncio.wait_for(mod.watch(anilist, lang, 1, ctx), 40)
            direct = [s for s in streams if isinstance(s, dict) and s.get('type') in ('hls', 'mp4') and isinstance(s.get('url'), str)]
            row['returned'] = len(direct)
            row['declaredAudio'] = sorted(set(str(s.get('audio'))[:12] for s in direct if s.get('audio')))
            row['subtitleCounts'] = [len(s.get('subtitles') or []) for s in direct[:2]]
            row['checks'] = []
            for s in direct[:2]:
                u = urlsplit(s['url'])
                if u.scheme != 'https' or not u.hostname or u.username or u.password:
                    continue
                check = {'type': s['type'], 'fingerprint': hashlib.sha256(s['url'].encode()).hexdigest()[:12]}
                try:
                    headers = {'Range': 'bytes=0-1023', 'User-Agent': 'Mozilla/5.0'}
                    referer = s.get('referer')
                    if isinstance(referer, str) and referer.startswith('https://'):
                        headers['Referer'] = referer
                    async with client.stream('GET', s['url'], headers=headers, follow_redirects=False, timeout=8) as res:
                        check['status'] = res.status_code
                        check['mime'] = res.headers.get('content-type', '').split(';')[0][:50]
                except Exception as exc:
                    check['error'] = reason(exc)
                row['checks'].append(check)
        except Exception as exc:
            row['error'] = reason(exc)
    return row


async def main():
    async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
        contexts = []
        for name, tmdb in SAMPLES:
            try:
                r = await client.get('https://api.ani.zip/mappings', params={'themoviedb_id': tmdb})
                r.raise_for_status()
                anilist = int(r.json()['mappings']['anilist_id'])
                ctx = await asyncio.wait_for(build_ctx(anilist), 30)
                contexts.append((name, anilist, ctx))
            except Exception as exc:
                contexts.append((name, None, reason(exc)))
        sem = asyncio.Semaphore(4)
        tasks = [one(client, sem, p, name, aid, ctx, lang)
                 for name, aid, ctx in contexts if aid
                 for p in PROVIDERS for lang in ('sub', 'dub')]
        return {'mapping': [{'title': n, 'ok': bool(a), **({'error': c} if not a else {})} for n, a, c in contexts],
                'rows': await asyncio.gather(*tasks)}

# Third-party debug logs may contain stream URLs: never emit them.
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    result = asyncio.run(main())
print('::notice title=Dedicated anime provider research::' + json.dumps(result, separators=(',', ':')))
