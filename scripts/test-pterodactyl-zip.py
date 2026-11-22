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
        assert 'vendor/tweetnacl/nacl-fast.js' in archive.namelist(), 'the tweetnacl fallback copy is missing'
        assert 'node_modules/tweetnacl/nacl-fast.js' in archive.namelist(), 'the bundled tweetnacl is missing'

    # Verify the extracted resolver can load its bundled native client without
    # npm or access to the workspace's node_modules.
    subprocess.run(['node', '--input-type=module', '-e', "const w = await import('wreq-js'); if (typeof w.fetch !== 'function') process.exit(1)"], cwd=tmp, check=True)

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
        # The proxy-list uploader used to be asserted here. That feature is gone
        # on purpose: the proxy route was abandoned in favour of the Cloudflare
        # worker, and /roxy/api/proxies no longer exists. Asserting on it made
        # this test fail for a reason unrelated to the archive, so what is
        # checked now is that the endpoint is really gone and that the panel
        # still authenticates and reports state.
        try:
            client.open(base + '/roxy/api/proxies')
            raise AssertionError('/roxy/api/proxies still exists; the proxy route was meant to be removed')
        except urllib.error.HTTPError as error:
            assert error.code == 404, f'expected 404 for the removed proxy route, got {error.code}'

        print('✓ ZIP upgrade overwrites older backend, preserves .env and data, and runs Roxy login and overview, and confirms the abandoned proxy uploader is gone.')
    finally:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
