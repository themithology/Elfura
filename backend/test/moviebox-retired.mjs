import assert from 'node:assert/strict';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
const before=process.env.ELFURA_MOVIEBOX_ENABLED;
try {
 process.env.ELFURA_MOVIEBOX_ENABLED='1';
 const registry=new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'fixture-only'}));
 assert(!registry.listPublicSources().some(s=>s.id==='source-26'),'old enabled environment setting must not register MovieBox');
 assert(!registry.describeSources().enabled.includes('source-26'));
 console.log('MovieBox remains retired even with a previously enabled .env setting');
} finally {
 if(before===undefined)delete process.env.ELFURA_MOVIEBOX_ENABLED;else process.env.ELFURA_MOVIEBOX_ENABLED=before;
}
