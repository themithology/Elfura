import assert from 'node:assert/strict';
import {buildTrackList, providerVariantLanguage} from '../../src/core/audio.ts';

// These are generic test fixtures, not registered production source IDs.
assert.equal(providerVariantLanguage({audioVariant:'sub'}),'ja');
assert.equal(providerVariantLanguage({audioVariant:'dub'}),'en');
assert.equal(providerVariantLanguage({audioVariant:'sub',audioLang:'en'}),null,'confirmed language wins over a provider hint');
assert.equal(providerVariantLanguage({audioVariant:'sub',availableAudioLangs:['en']}),null);
assert.equal(providerVariantLanguage({audioVariant:'dub',multiAudio:true}),null);
const tracks=buildTrackList({native:[{id:0,lang:'und',label:'Audio'}],discoveredSourceLangs:[
 {lang:'ja',active:true,providerHint:true},{lang:'ja',providerHint:true},{lang:'en',providerHint:true},{lang:'en',providerHint:true},
]});
assert.equal(tracks.filter(t=>t.lang==='ja').length,1);
assert.equal(tracks.filter(t=>t.lang==='en').length,1);
assert.equal(tracks.find(t=>t.lang==='ja').providerHint,true);
assert.equal(tracks.find(t=>t.lang==='en').providerHint,true);
const confirmed=buildTrackList({native:[{id:0,lang:'en',label:'English'}],discoveredSourceLangs:[{lang:'en',providerHint:true}]});
assert.equal(confirmed.length,1);assert.equal(confirmed[0].providerHint,undefined);
console.log('audio variant labels: deduplication, explicit hint handling, and verified-track precedence passed');
