// Read-only live-panel playback research. Never print session tokens or stream URLs.
const base = 'https://embed.theogpiratebot.online';
const headers = { Origin: 'https://embed.theogpiratebot.online', 'User-Agent': 'Mozilla/5.0 Chrome/137.0.0.0 Safari/537.36', 'Content-Type': 'application/json' };
const sessionRes = await fetch(`${base}/api/v1/session`, { method: 'POST', headers, body: JSON.stringify({type:'tv',tmdb:'289517'}), signal: AbortSignal.timeout(12000) });
const sess = await sessionRes.json();
if (!sess.pltoken || !sess.nonce) throw new Error(`session HTTP ${sessionRes.status}`);
for (const source of ['combined','source-2','combined']) {
  const t = Date.now();
  const url = `${base}/api/v1/playback?type=tv&tmdb=289517&s=1&e=1&nonce=${encodeURIComponent(sess.nonce)}${source === 'combined' ? '' : '&source=source-2'}`;
  const res = await fetch(url, { headers: {...headers, 'X-Playback-Token':sess.pltoken}, signal: AbortSignal.timeout(20000) });
  const body = await res.json();
  const counts = {};
  for (const option of body.sources || []) counts[option.sourceId] = (counts[option.sourceId] || 0) + 1;
  const multi = (body.sources || []).filter(x => x.multiAudio).map(x => ({source:x.sourceId, langs:x.availableAudioLangs || [], qualities:x.qualityOptions || 0}));
  console.log(`::notice title=LivePlayback::${JSON.stringify({source,status:res.status,ms:Date.now()-t,counts,multi})}`);
}
