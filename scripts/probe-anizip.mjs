// The mappings object is where the ids live. Print it whole for three titles.
const show = async (u) => {
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  console.log('===', u, '->', r.status);
  if (j?.mappings) console.log(JSON.stringify(j.mappings));
  console.log('  titles.en =', j?.titles?.en);
  console.log('');
};
await show('https://api.ani.zip/mappings?themoviedb_id=46260');
await show('https://api.ani.zip/mappings?themoviedb_id=85937');
await show('https://api.ani.zip/mappings?themoviedb_id=1399');
