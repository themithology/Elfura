/** Conservative DASH HEVC-only detection. Unknown/mixed codecs are not rejected. */
export function dashIsHevcOnly(xml: string): boolean {
  let videoRepresentations = 0;
  const attr = (tag: string, name: string): string =>
    tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] ?? '';
  // If a self-closing set appears, the layout may be outside what this small
  // detector understands; do not reject a possibly playable alternative.
  if (/<AdaptationSet\b[^>]*\/\s*>/i.test(xml)) return false;
  for (const match of xml.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet\s*>/gi)) {
    const attrs = match[1];
    const type = attr(attrs, 'contentType').toLowerCase();
    const mime = attr(attrs, 'mimeType').toLowerCase();
    const reps = [...match[2].matchAll(/<Representation\b([^>]*?)(?:\/?>)/gi)];
    const isVideo = type === 'video' || mime.startsWith('video/') || reps.some(r => attr(r[1], 'mimeType').toLowerCase().startsWith('video/'));
    if (!isVideo) continue;
    if (reps.length === 0) return false;
    for (const rep of reps) {
      const codec = attr(rep[1], 'codecs') || attr(attrs, 'codecs');
      if (!codec || !/^(?:hvc1|hev1)(?:\.|$)/i.test(codec.trim())) return false;
      videoRepresentations++;
    }
  }
  return videoRepresentations > 0;
}
