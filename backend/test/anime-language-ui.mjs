import assert from 'node:assert/strict';
import {buildTrackList, providerVariantLanguage} from '../../src/core/audio.ts';

for (const sourceId of ['source-16','source-29','source-30']) {
  assert.equal(providerVariantLanguage({sourceId,audioVariant:'sub'}),'ja');
  assert.equal(providerVariantLanguage({sourceId,audioVariant:'dub'}),'en');
}
assert.equal(providerVariantLanguage({sourceId:'source-3',audioVariant:'sub'}),null);
assert.equal(providerVariantLanguage({sourceId:'source-30',audioVariant:'sub',audioLang:'en'}),null,'confirmed language wins over the provider hint');
assert.equal(providerVariantLanguage({sourceId:'source-30',audioVariant:'sub',availableAudioLangs:['en']}),null);
assert.equal(providerVariantLanguage({sourceId:'source-30',audioVariant:'dub',multiAudio:true}),null);
const tracks=buildTrackList({native:[{id:0,lang:'und',label:'Audio'}],discoveredSourceLangs:[
 {lang:'ja',active:true,providerHint:true},{lang:'ja',providerHint:true},{lang:'en',providerHint:true},{lang:'en',providerHint:true},
]});
assert.equal(tracks.filter(t=>t.lang==='ja').length,1);
assert.equal(tracks.filter(t=>t.lang==='en').length,1);
assert.equal(tracks.find(t=>t.lang==='ja').providerHint,true);
assert.equal(tracks.find(t=>t.lang==='en').providerHint,true);
const confirmed=buildTrackList({native:[{id:0,lang:'en',label:'English'}],discoveredSourceLangs:[{lang:'en',providerHint:true}]});
assert.equal(confirmed.length,1);assert.equal(confirmed[0].providerHint,undefined);
console.log('anime language labels: deduplication, provider hints and verified track precedence passed');
