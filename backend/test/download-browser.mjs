import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import assert from 'node:assert/strict';
const wrap=u=>'https://tgdl.lovable.app/dl?u='+Buffer.from(u).toString('base64url');
const orig=globalThis.fetch;
globalThis.fetch=async (url,opts)=>String(url).startsWith('https://tgdl.lovable.app/api/')?new Response(JSON.stringify({success:true,type:'movie',tmdb_id:550,downloads:[{name:'Fight Club Hindi + English.mkv',quality:'720p',size:'850 MB',download_url:wrap('https://pixeldrain.dev/api/file/abc?download')},{name:'Fight Club Tamil.mkv',quality:'1080p',size:'2 GB',download_url:wrap('https://pixeldrain.dev/api/file/def?download')},{name:'Playlist',quality:'1080p',download_url:wrap('https://hdhub.thevolecitor.qzz.io/x.m3u8')}]}),{status:200,headers:{'content-type':'application/json'}}):orig(url,opts);
const {server}=createBackendServer({...loadBackendConfig(),isProd:false,requireToken:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:chromiumBinary.args});
 for(const mobile of [true,false]){
  const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1360,height:900},isMobile:mobile,hasTouch:mobile});
  await page.goto(base+'/dl/movie/550',{waitUntil:'domcontentloaded'});await page.waitForSelector('#results:not([hidden])',{timeout:10000});
  assert.equal(await page.locator('.language').count(),3);assert.equal(await page.locator('.file-row').count(),1);
  assert((await page.locator('.file-row').innerText()).includes('720p'));await page.getByRole('button',{name:'Tamil',exact:true}).click();assert((await page.locator('.file-row').innerText()).includes('1080p'));
  await page.getByRole('button',{name:'Hindi',exact:true}).click();await page.getByText('View download').click();await page.waitForFunction(()=>document.querySelector('#download')&&!document.querySelector('#download').hidden,null,{timeout:5000});
  assert((await page.locator('#file-name').innerText()).includes('Hindi + English'));
  const ticket=new URL(page.url()).searchParams.get('t');assert(ticket&&!page.url().includes('pixeldrain'));
  const response=await fetch(base+'/dl/go?t='+encodeURIComponent(ticket),{redirect:'manual'});assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://pixeldrain.dev/api/file/abc?download');
  const width=await page.evaluate(()=>({doc:document.documentElement.scrollWidth,viewport:innerWidth}));assert(width.doc<=width.viewport,'horizontal overflow');
  console.log('::notice title=DownloadBrowser::'+JSON.stringify({mobile,ok:true,languageCount:3,width}));
 }
 const bad=await fetch(base+'/dl/api/file?t=invalid');assert.equal(bad.status,410);
}catch(e){console.log('::notice title=DownloadBrowser::'+JSON.stringify({ok:false,error:String(e)}));process.exitCode=1;}finally{await browser?.close();await new Promise(r=>server.close(r));globalThis.fetch=orig;}
