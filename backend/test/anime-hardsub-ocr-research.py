"""Summarise OCR in ephemeral player frames; do not publish frames or text.

OCR can mistake credits, logos or background text for subtitles. Counts alone
are not confirmation of English subtitles or accurate timing.
"""
import glob
import io
import json
import os
import re
import subprocess
from PIL import Image

def _png(image):
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()

rows = []
for path in sorted(glob.glob(os.path.join(os.environ['AUDIT_AUDIO_DIR'], '*.png'))):
    name = os.path.basename(path).removesuffix('.png')
    try:
        with Image.open(path) as image:
            # Subtitles usually occupy the lower portion of an anime frame.
            image = image.crop((0, int(image.height * .68), image.width, image.height))
            proc = subprocess.run(['tesseract', 'stdin', 'stdout', '-l', 'eng', '--psm', '6'],
                                  input=_png(image), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  timeout=10, check=True)
        text = proc.stdout.decode('utf8', errors='replace')
        words = re.findall(r"[A-Za-z]{2,}", text)
        common = sum(w.lower() in {'a','an','and','are','at','be','but','do','for','from','have','he','her','how','i','in','is','it','me','my','no','not','of','on','or','she','that','the','they','this','to','we','what','with','you','your'} for w in words)
        rows.append({'frame': name, 'words': len(words), 'commonEnglishWords': common})
    except Exception as exc:
        rows.append({'frame': name, 'error': type(exc).__name__})
print('::notice title=Burned-in subtitle OCR indicators::' + json.dumps(rows, separators=(',', ':')))
