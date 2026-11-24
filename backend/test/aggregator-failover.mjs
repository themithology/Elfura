// Exercise the actual player method: a lane that declares itself an aggregator
// fronts independent upstreams, so a manual group selection must not abandon its
// remaining lanes after the first fails. Ordinary automatic fallback and language
// search stay intact. The fixtures carry `traits` rather than a provider id —
// that is the whole contract between the backend and the player now.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundled=await build({entryPoints:['src/core/player.ts'],bundle:true,platform:'node',format:'esm',write:false,external:['hls.js','dashjs']});
const {ElfuraPlayer}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const opt=(id,sourceId,latencyHintMs,traits)=>({id,sourceId,latencyHintMs,traits,url:id,quality:'auto',audioTracks:[]});
const source17bad=opt('17-bad','source-17',10,['aggregator']),source17good=opt('17-good','source-17',900,['aggregator']),other=opt('other','source-1',1,['aggregator']);
function player(){const p=Object.create(ElfuraPlayer.prototype);p.sources=[source17bad,other,source17good];p.currentSource=null;p.audioSearchSeq=0;p.activeProbe=null;p.failedSourceIds=new Set();p.failedFingerprints=new Set();p.desiredAudioLang=null;p.manualAggregatorGroup=null;p.emit=()=>{};p.activateSourceOption=async o=>{p.currentSource=o};return p}
const p=player();await p.setSource('17-bad');p.failover();assert.equal(p.currentSource.id,'17-good','a manually chosen aggregator tries its other upstream before switching groups');p.failover();assert.equal(p.currentSource.id,'other','after aggregator exhaustion, ordinary fallback remains available');
const auto=player();auto.currentSource=source17bad;auto.failover();assert.equal(auto.currentSource.id,'other','automatic failover still prefers another provider group');
const manualOther=player();await manualOther.setSource('other');manualOther.failover();assert.equal(manualOther.currentSource.id,'17-bad','manual selection of other sources keeps normal failover');
const language=player();await language.setSource('17-bad');language.desiredAudioLang='hi';let searched=false;language.searchRawSourcesForLanguage=async lang=>{searched=lang==='hi'};language.failover();assert(searched,'when no TGVIDX lane is confirmed for the language, retain the cross-provider search');
const languageMatch=player();languageMatch.sources=[source17bad,other,{...source17good,audioLang:'hi'}];await languageMatch.setSource('17-bad');languageMatch.desiredAudioLang='hi';languageMatch.searchRawSourcesForLanguage=async()=>{throw Error('should prefer confirmed matching TGVIDX')};languageMatch.failover();assert.equal(languageMatch.currentSource.id,'17-good','language-confirmed TGVIDX fallback should be tried within the group');
const wrongLanguage=player();wrongLanguage.sources=[source17bad,other,{...source17good,audioLang:'en'}];await wrongLanguage.setSource('17-bad');wrongLanguage.desiredAudioLang='hi';let globalSearch=false;wrongLanguage.searchRawSourcesForLanguage=async()=>{globalSearch=true};wrongLanguage.failover();assert(globalSearch,'never claim a mismatched TGVIDX language');
console.log('aggregator manual/automatic failover and language behavior: OK');
