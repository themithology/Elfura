import assert from 'node:assert/strict';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';

const defaults = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'nuvio-stack-test' })).listPublicSources();
for (const id of ['source-18', 'source-19', 'source-20']) assert(!defaults.some(source => source.id === id), `${id} remains opt-in pending live checks`);
const enabled = new SourceRegistry(loadBackendConfig({
  ELFURA_SECRET: 'nuvio-stack-test',
  ELFURA_VIDLOVE_ENABLED: '1',
  ELFURA_MOVIESAPI_ENABLED: '1',
  ELFURA_ZENIX_ENABLED: '1',
})).listPublicSources();
assert(enabled.some(source => source.id === 'source-18' && source.label === 'VidLove · CineHD/CineJoy'));
assert(enabled.some(source => source.id === 'source-19' && source.label === 'MoviesAPI · FMovies'));
assert(enabled.some(source => source.id === 'source-20' && source.label === 'Zenix'));
console.log('✓ Nuvio stack adapters are independently opt-in and expose their actual media-provider families');
