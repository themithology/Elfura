// Ask the operator's live resolver port what it actually is.
const targets = [
  'http://91.92.35.88:3002/api/v1/health',
  'http://91.92.35.88:3002/resolver/api/health',
  'http://91.92.35.88:3003/resolver/api/health',
  'http://91.92.35.88:3003/api/v1/health',
  'http://91.92.35.88:3002/',
];
for (const t of targets) {
  const started = Date.now();
  try {
    const r = await fetch(t, { signal: AbortSignal.timeout(10000) });
    const body = (await r.text()).slice(0, 200).replace(/\s+/g, ' ');
    console.log(`${t} -> ${r.status} (${Date.now() - started}ms) ${body}`);
  } catch (e) {
    const name = e?.name ?? '';
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    console.log(`${t} -> FAIL ${name} ${cause} (${Date.now() - started}ms)`);
  }
}
