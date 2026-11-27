// Exercise the actual player method: a manual provider choice should try its
// sibling options before silently abandoning the selected server family. Ordinary
// automatic fallback and language search stay intact.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundled=await build({entryPoints:['src/core/player.ts'],bundle:true,platform:'node',format:'esm',write:false,external:['hls.js','dashjs']});
const {ElfuraPlayer}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const opt=(id,sourceId,latencyHintMs)=>({id,sourceId,latencyHintMs,url:id,quality:'auto',audioTracks:[]});
const source17bad=opt('17-bad','source-17',10),source17good=opt('17-good','source-17',900),other=opt('other','source-1',1);
function player(){const p=Object.create(ElfuraPlayer.prototype);p.sources=[source17bad,other,source17good];p.currentSource=null;p.audioSearchSeq=0;p.activeProbe=null;p.failedSourceIds=new Set();p.failedFingerprints=new Set();p.desiredAudioLang=null;p.manualSourceGroup=null;p.emit=()=>{};p.activateSourceOption=async o=>{p.currentSource=o};return p}
const p=player();await p.setSource('17-bad');p.failover();assert.equal(p.currentSource.id,'17-good','manual TGVIDX must try its other upstream before switching groups');p.failover();assert.equal(p.currentSource.id,'other','after TGVIDX exhaustion, ordinary fallback remains available');
const regularBad=opt('regular-bad','source-1',10),regularGood=opt('regular-good','source-1',900),regularBackup=opt('regular-backup','source-2',1);
const manualRegular=player();manualRegular.sources=[regularBad,regularBackup,regularGood];await manualRegular.setSource('regular-bad');manualRegular.failover();assert.equal(manualRegular.currentSource.id,'regular-good','manual ordinary source selection must try sibling options before leaving its group');manualRegular.failover();assert.equal(manualRegular.currentSource.id,'regular-backup','after manual group options fail, fallback to another provider remains available');
const auto=player();auto.currentSource=source17bad;auto.failover();assert.equal(auto.currentSource.id,'other','automatic failover still prefers another provider group');
const manualOther=player();await manualOther.setSource('other');manualOther.failover();assert.equal(manualOther.currentSource.id,'17-bad','manual selection of other sources keeps normal failover');
const language=player();await language.setSource('17-bad');language.desiredAudioLang='hi';let searched=false;language.searchRawSourcesForLanguage=async lang=>{searched=lang==='hi'};language.failover();assert(searched,'when no TGVIDX lane is confirmed for the language, retain the cross-provider search');
const languageMatch=player();languageMatch.sources=[source17bad,other,{...source17good,audioLang:'hi'}];await languageMatch.setSource('17-bad');languageMatch.desiredAudioLang='hi';let preferredSearch=null;languageMatch.searchRawSourcesForLanguage=async(lang,_label,excluded)=>{preferredSearch={lang,excluded:[...excluded]}};languageMatch.failover();assert.equal(preferredSearch.lang,'hi','manual language failover must use the confirmed desired language');assert.equal(languageMatch.manualSourceGroup,'source-17','keep the manually chosen group as the first search tier');
const wrongLanguage=player();wrongLanguage.sources=[source17bad,other,{...source17good,audioLang:'en'}];await wrongLanguage.setSource('17-bad');wrongLanguage.desiredAudioLang='hi';let globalSearch=false;wrongLanguage.searchRawSourcesForLanguage=async()=>{globalSearch=true};wrongLanguage.failover();assert(globalSearch,'never claim a mismatched TGVIDX language');
console.log('Manual source-group fallback, automatic fallback and language behavior: OK');
