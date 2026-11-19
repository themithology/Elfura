// Read-only browser test of the user's deployed player. Never log URLs or tokens.
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const browser = await chromium.launch({executablePath: await chromiumBinary.executablePath(), args:[...chromiumBinary.args, '--autoplay-policy=no-user-gesture-required']});
let page;
let step = 'launch';
function notice(message) { console.log(`::notice title=SquidBrowser::${JSON.stringify(message).replace(/%/g,'%25').replace(/\n/g,'%0A')}`); }
try {
  page = await browser.newPage({ userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36' });
  step = 'embed';
  await page.goto('https://embed.theogpiratebot.online/embed/tv/93405/1/1', {waitUntil:'domcontentloaded', timeout:30000});
  await page.waitForFunction(() => window.__elfura?.player?.getSources().some(s => s.sourceId === 'source-2' && s.multiAudio), null, {timeout:55000});
  const result = await page.evaluate(() => {
    const p = window.__elfura.player;
    const option = p.getSources().find(s => s.sourceId === 'source-2' && s.multiAudio);
    return {id: option.id, langs: option.availableAudioLangs, qualities: option.qualityLadder};
  });
  notice({step:'source-2-discovered', languages:result.langs, qualityHeights:result.qualities});
  step = 'select-source';
  await page.evaluate(async id => {
    const p = window.__elfura.player; p.video.muted = true;
    window.__squidEvents = [];
    let observed;
    window.__squidTimer = setInterval(() => {
      if (!p.hls || p.hls === observed) return;
      observed = p.hls;
      window.__squidEvents.push({event:'engine-attached', tracks:p.hls.audioTracks.length});
      for (const event of ['hlsError','hlsManifestParsed','hlsFragLoaded','hlsFragBuffered','hlsAudioTrackLoaded','hlsLevelLoaded']) {
        observed.on(event, (_event, data) => {
          if (window.__squidEvents.length >= 50) return;
          window.__squidEvents.push({event, details:data?.details || null, fatal:!!data?.fatal, code:data?.response?.code || data?.networkDetails?.status || null, fragType:data?.frag?.type || null});
        });
      }
    }, 50);
    await p.setSource(id); await p.play();
  }, result.id);
  await page.waitForFunction(() => {
    const p = window.__elfura.player;
    return p.currentSource?.sourceId === 'source-2' && p.currentSource?.multiAudio && p.hls && p.getAudioTracks().some(t => t.lang === 'hi');
  }, null, {timeout:35000});
  const trackSummary = await page.evaluate(() => ({tracks:window.__elfura.player.getAudioTracks().map(t=>({lang:t.lang,kind:t.kind})), heights:window.__elfura.player.getQualityLevels().map(l=>l.height)}));
  notice({step:'source-2-engine-tracks', ...trackSummary});
  for (const lang of ['hi','en','ko']) {
    step = `switch-${lang}`;
    const switched = await page.evaluate(async requested => {
      const p=window.__elfura.player;
      window.__squidAudioFragments = 0;
      const hls=p.hls;
      const listener=(_evt,data) => { if (data.frag?.type === 'audio') window.__squidAudioFragments++; };
      if (window.__squidListener) hls.off('hlsFragBuffered', window.__squidListener);
      window.__squidListener=listener;
      hls.on('hlsFragBuffered', listener);
      const ok=await p.setAudio(requested);
      return {ok, current:p.getState().audioLang, nativeLang:hls.audioTracks[hls.audioTrack]?.lang || null, nativeIndex:hls.audioTrack};
    }, lang);
    await page.waitForFunction(() => window.__squidAudioFragments > 0, null, {timeout:20000}).catch(() => {});
    const state = await page.evaluate(() => ({audioFragments:window.__squidAudioFragments || 0, current:window.__elfura.player.getState().audioLang, videoTime:window.__elfura.player.getState().time, source:window.__elfura.player.currentSource?.sourceId || null}));
    notice({step, ...switched, ...state});
    if (state.source !== 'source-2' || !state.audioFragments) {
      const events=await page.evaluate(() => window.__squidEvents || []);
      notice({step:'engine-events', events});
      process.exitCode = 1;
      break;
    }
  }
} catch (error) {
  const snapshot = await page?.evaluate(() => ({source:window.__elfura?.player?.currentSource?.sourceId || null, counts:(window.__elfura?.player?.getSources() || []).reduce((a,s)=>(a[s.sourceId]=(a[s.sourceId]||0)+1,a),{}), audio:window.__elfura?.player?.getState().audioLang || null})).catch(() => null);
  notice({step, error:error.name, snapshot});
  process.exitCode = 1;
} finally { await browser.close(); }
