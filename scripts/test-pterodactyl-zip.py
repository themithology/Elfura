#!/usr/bin/env python3
"""Smoke-test the actual deployment archive over an existing installation."""
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

root = Path(__file__).resolve().parent.parent
bundle = root / 'elfura-pterodactyl.zip'
with tempfile.TemporaryDirectory(prefix='elfura-deploy-test-') as tmp:
    target = Path(tmp)
    (target / 'dist/backend').mkdir(parents=True)
    stale = target / 'dist/backend/index.js'
    stale.write_text('// stale backend without dashboard\n')
    old_time = time.time() - 600
    os.utime(stale, (old_time, old_time))
    (target / '.env').write_text('ELFURA_SECRET=test-deploy-password\nALLOWED_ORIGINS=*\n')
    (target / 'data').mkdir()
    persisted = '{"events":[],"bans":["https://example.org"]}'
    (target / 'data/roxy.json').write_text(persisted)
    with zipfile.ZipFile(bundle) as archive:
        assert '.env' not in archive.namelist()
        assert not any(name.startswith('data/') for name in archive.namelist())
    subprocess.run(['unzip', '-o', '-u', '-q', str(bundle), '-d', tmp], check=True)
    with zipfile.ZipFile(bundle) as archive:
        assert hashlib.sha256(stale.read_bytes()).digest() == hashlib.sha256(archive.read('dist/backend/index.js')).digest(), 'old backend was not overwritten'
    assert (target / '.env').read_text() == 'ELFURA_SECRET=test-deploy-password\nALLOWED_ORIGINS=*\n'
    assert (target / 'data/roxy.json').read_text() == persisted
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    # Panels that run `npm install` at boot must succeed. Vendoring undici as a
    # `file:` dependency made npm execute undici's own `prepare` script
    # (`husky && node ./scripts/platform-shell.js`), which aborted the whole
    # install and left the proxy layer permanently unavailable. Offline check:
    # the archive must carry no lifecycle scripts at all.
    with zipfile.ZipFile(bundle) as archive:
        for name in archive.namelist():
            if name.endswith('/package.json'):
                manifest = json.loads(archive.read(name))
                assert not manifest.get('scripts'), f'{name} still declares lifecycle scripts: {manifest["scripts"]}'
        assert 'vendor/undici/index.js' in archive.namelist(), 'the undici fallback copy is missing'
        assert 'node_modules/undici/index.js' in archive.namelist(), 'the bundled undici is missing'

    env = dict(os.environ, HOST='127.0.0.1', SERVER_PORT=str(port))
    env.pop('ELFURA_SECRET', None); env.pop('ROXY_DATA_DIR', None)
    process = subprocess.Popen(['node', 'index.js'], cwd=tmp, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    base = f'http://127.0.0.1:{port}'
    try:
        for _ in range(100):
            try:
                health = json.load(urllib.request.urlopen(base + '/api/v1/health', timeout=1))
                break
            except (OSError, urllib.error.URLError):
                if process.poll() is not None: raise RuntimeError('backend exited early')
                time.sleep(.1)
        else: raise RuntimeError('backend did not start')
        assert health['features']['roxy'] is True
        page = urllib.request.urlopen(base + '/roxy')
        assert page.status == 200 and b'PRIVATE CONTROL ROOM' in page.read()
        client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        req = urllib.request.Request(base + '/roxy/api/login', data=json.dumps({'password':'test-deploy-password'}).encode(), headers={'Origin':base,'Content-Type':'application/json'})
        assert client.open(req).status == 200
        overview = json.load(client.open(base + '/roxy/api/overview'))
        assert overview['bans'] == ['https://example.org']

        # The proxy uploader is the feature an operator reaches for when a source
        # has gone quiet, so it is exercised against the real extracted bundle:
        # the list saves, and the panel is told whether the proxy layer is live.
        proxy_req = urllib.request.Request(
            base + '/roxy/api/proxies',
            data=json.dumps({'text': '45.38.107.97:6014:jaaphwvh:7mmcluipg93z\r\n64.137.96.74:6641:jaaphwvh:7mmcluipg93z'}).encode(),
            headers={'Origin': base, 'Content-Type': 'application/json'},
        )
        saved = json.load(client.open(proxy_req))
        assert saved['count'] == 2, saved
        assert saved['applied'] is True, 'the bundle must install the egress profile that uses the list'
        assert saved['problem'] == '', saved['problem']
        assert all('7mmcluipg93z' not in json.dumps(row) for row in saved['proxies']), 'credentials leaked to the panel'
        assert (target / 'data/proxies.json').is_file(), 'the list is not persisted for the next boot'

        print('✓ ZIP upgrade overwrites older backend, preserves .env and data, and runs Roxy login, overview and the proxy uploader.')
    finally:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
