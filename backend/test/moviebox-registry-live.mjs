// Real MovieBox resolver through the production registry and sealed options.
// Only the catalogue metadata endpoint is mocked; no credentials or URLs logged.
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {createSource26Adapter} from '../../dist/backend/sources/source26.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
const original=globalThis.fetch;
globalThis.fetch=async (input,init)=>{
 const u=new URL(String(input));
 if(u.hostname==='tmdb-fixture.example') return Response.json({id:550,title:'Fight Club',original_title:'Fight Club',release_date:'1999-10-15',original_language:'en'});
 if(u.hostname==='cdn-fixture.example') return new Response(new Uint8Array(1024),{status:206,headers:{'content-type':'video/mp4'}});
 return original(input,init);
};
try {
 const cfg=loadBackendConfig({ELFURA_SECRET:'registry-test-secret',TMDB_API_BASE:'https://tmdb-fixture.example',TMDB_API_KEY:'fixture',OPENSUBTITLES_ENABLED:'0'});
 const registry=new SourceRegistry(cfg);
 const moviebox=createSource26Adapter(()=>true);
 registry.adapters=[moviebox];
 const result=await registry.resolvePlayback({type:'movie',tmdbId:'550',sourceId:'source-26'});
 const opts=result?.sources?.map(s=>({type:s.type,lang:s.audioLang??null,label:s.label,multi:!!s.multiAudio,quality:s.quality}))??[];
 console.log('::notice title=MovieBox registry options::'+JSON.stringify(opts));
 if(!opts.some(s=>s.lang==='en'))throw Error('English not surfaced in actual registry');
 if(!opts.some(s=>s.lang==='hi' && s.label.includes('Hindi') && !s.multi))throw Error('Hindi separate stream not surfaced in actual registry');
 if(!opts.some(s=>s.type==='mp4' && s.lang==='en' && s.label.includes('English')))throw Error('English MP4 not surfaced in actual registry');
} finally {globalThis.fetch=original;}
