/** Return advertised video codecs only when every video representation is known to be HEVC. */
export function dashHevcCodecs(xml: string): string[] | null {
  const codecs: string[] = [];
  const attr = (tag: string, name: string): string =>
    tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] ?? '';
  // If a self-closing set appears, the layout may be outside what this small
  // detector understands; do not reject a possibly playable alternative.
  if (/<AdaptationSet\b[^>]*\/\s*>/i.test(xml)) return null;
  for (const match of xml.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet\s*>/gi)) {
    const attrs = match[1];
    const type = attr(attrs, 'contentType').toLowerCase();
    const mime = attr(attrs, 'mimeType').toLowerCase();
    const reps = [...match[2].matchAll(/<Representation\b([^>]*?)(?:\/?>)/gi)];
    const isVideo = type === 'video' || mime.startsWith('video/') || reps.some(r => attr(r[1], 'mimeType').toLowerCase().startsWith('video/'));
    if (!isVideo) {
      // An untyped set may contain an alternative video representation.
      if (!type && !mime && (!reps.length || !reps.every(r => /^(?:audio|text|application)\//i.test(attr(r[1], 'mimeType'))))) return null;
      continue;
    }
    if (mime && mime !== 'video/mp4') return null;
    if (reps.length === 0) return null;
    for (const rep of reps) {
      const repMime = attr(rep[1], 'mimeType').toLowerCase();
      if (repMime && repMime !== 'video/mp4') return null;
      const codec = (attr(rep[1], 'codecs') || attr(attrs, 'codecs')).trim();
      if (!codec || !/^(?:hvc1|hev1)(?:\.|$)/i.test(codec)) return null;
      codecs.push(codec);
    }
  }
  return codecs.length ? [...new Set(codecs)] : null;
}

export function dashIsHevcOnly(xml: string): boolean {
  return dashHevcCodecs(xml) !== null;
}

/** A generic HEVC probe can fail for one profile while the actual stream works. */
export function dashHevcDefinitelyUnsupported(xml: string, supports: (mime: string) => boolean): boolean {
  const codecs = dashHevcCodecs(xml);
  if (!codecs) return false;
  try {
    return codecs.every(codec => !supports(`video/mp4; codecs="${codec}"`));
  } catch {
    // Capability APIs can be absent or throw: let dash.js try in that case.
    return false;
  }
}
