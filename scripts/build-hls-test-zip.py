#!/usr/bin/env python3
"""Create a full isolated HLS test deployment from the standard pre-built ZIP."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
root=Path(__file__).resolve().parent.parent
base=root/'elfura-pterodactyl.zip'
out=root/'elfura-hls-converter-test.zip'
root_entries={f'{n}.{ext}' for n in ('index','server','app','main','bot','start') for ext in ('js','ts')}
src_entries={'src/index.js','src/index.ts'}
root_shim="""import { startBackendServer } from './dist/backend/index.js';
import { installTestFfmpeg } from './hls-test-installer.mjs';
process.env.ELFURA_EXPERIMENTAL_HLS_DOWNLOADS ??= '1';
startBackendServer();
void installTestFfmpeg();
"""
src_shim=root_shim.replace("'./dist/", "'../dist/").replace("'./hls-test-installer.mjs'", "'../hls-test-installer.mjs'")
with ZipFile(base) as original, ZipFile(out,'w',ZIP_DEFLATED,compresslevel=9) as result:
    for item in original.infolist():
        if item.filename in root_entries: data=root_shim.encode()
        elif item.filename in src_entries: data=src_shim.encode()
        else: data=original.read(item.filename)
        result.writestr(item,data)
    result.write(root/'scripts/test-ffmpeg-installer.mjs','hls-test-installer.mjs')
print(f'Test deployment: {out} ({out.stat().st_size:,} bytes)')
