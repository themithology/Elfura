"""Research-only approximate language detection; never prints speech or saves transcripts.

Short clips can contain music or silence, and automatic language detection is
not proof of dubbed/subbed dialogue. Audio and downloaded model are ephemeral on
the Actions runner and must not be uploaded as artifacts.
"""
import json
import os
import subprocess
import traceback
from pathlib import Path

result = []
try:
    import numpy as np
    from faster_whisper import WhisperModel
    model = WhisperModel('tiny', device='cpu', compute_type='int8', cpu_threads=2)
    for path in sorted(Path(os.environ['AUDIT_AUDIO_DIR']).glob('*.webm')):
        try:
            # ffmpeg bypasses an incompatible faster-whisper / PyAV decoder API.
            pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'f32le',
                                  '-ac', '1', '-ar', '16000', 'pipe:1'],
                                 check=True, capture_output=True, timeout=30).stdout
            samples = np.frombuffer(pcm, dtype='<f4')
            segments, info = model.transcribe(samples, beam_size=1, vad_filter=True)
            count = sum(1 for _ in segments)
            title_id, episode, expected = path.stem.split('-')
            result.append({'titleId': title_id, 'episode': int(episode), 'track': expected,
                           'detected': info.language, 'probability': round(info.language_probability, 3) if info.language_probability is not None else None,
                           'segments': count})
        except Exception as exc:
            last = traceback.extract_tb(exc.__traceback__)[-1]
            message = str(exc).replace(str(path), '[clip]').replace(os.environ['AUDIT_AUDIO_DIR'], '[temp]')
            result.append({'clip': path.stem, 'error': type(exc).__name__, 'at': last.name, 'line': last.lineno, 'message': message[:120]})
    print('::notice title=Automatic audio language research::' + json.dumps({'clips': result}, separators=(',', ':')))
except Exception as exc:
    print('::notice title=Automatic audio language research::' + json.dumps({'unavailable': type(exc).__name__}, separators=(',', ':')))
