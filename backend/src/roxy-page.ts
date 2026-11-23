/** Same-origin admin UI; all dynamic values are inserted as text, never HTML. */
export const ROXY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Roxy · Elfura</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#10120f;color:#f2f3ed}*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit}button{cursor:pointer}header{height:72px;border-bottom:1px solid #30362b;display:flex;align-items:center;justify-content:space-between;padding:0 5vw}.brand{font-weight:800;letter-spacing:.12em;font-size:13px}.brand b{color:#d6ff89}.pill{color:#c5e89a;font-size:12px}.container{max-width:1300px;margin:auto;padding:44px 5vw 80px}.eyebrow{text-transform:uppercase;letter-spacing:.18em;color:#b0c19c;font-size:11px;font-weight:700}h1{font-size:clamp(30px,4vw,48px);letter-spacing:-.04em;margin:10px 0}h2{font-size:16px;margin:0}.muted{color:#9da796;font-size:13px;line-height:1.5}.top{display:flex;align-items:end;justify-content:space-between;gap:20px}.toolbar{display:flex;gap:8px;flex-wrap:wrap}button,.button{border:1px solid #414a3b;background:#242a21;color:#eef1e7;border-radius:8px;padding:10px 14px}button:hover{border-color:#b7db82}.primary{background:#d5fa9c;color:#14200d;border-color:#d5fa9c;font-weight:700}.danger{color:#ffaca6}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:30px 0}.card,.panel{background:#1a1e18;border:1px solid #30382c;border-radius:12px;padding:20px}.card strong{display:block;font-size:32px;margin:15px 0 3px}.card span{font-size:13px;color:#adb8a4}.layout{display:grid;grid-template-columns:1.1fr 1fr;gap:12px;margin-top:12px}.panelhead{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px}.full{grid-column:1/-1}.chart{height:160px;display:flex;align-items:end;gap:3px;border-bottom:1px solid #394335}.bar{background:#c1eb8d;border-radius:3px 3px 0 0;flex:1;min-height:2px}.axis{display:flex;justify-content:space-between;margin-top:9px;font-size:11px;color:#899485}.row{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid #30382c;font-size:13px}.row:last-child{border:0}.row .name{flex:1;overflow-wrap:anywhere}.row strong{font-variant-numeric:tabular-nums}.tag{color:#bbda99;font-size:11px}.error{color:#ffa49b}.empty{color:#879280;font-size:13px;padding:16px 0}.probe{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}input,select{background:#10140f;border:1px solid #404b3b;color:#f2f3ed;border-radius:8px;padding:10px;min-width:0}.probe input{width:130px}.login{max-width:390px;margin:12vh auto}.login input{width:100%;margin:20px 0 10px}.login button{width:100%}.hidden{display:none}.notice{color:#e6c483;font-size:12px;margin-top:14px}@media(max-width:800px){.grid{grid-template-columns:repeat(2,1fr)}.layout{grid-template-columns:1fr}.full{grid-column:auto}.top{align-items:start;flex-direction:column}}@media(max-width:420px){.grid{grid-template-columns:1fr 1fr}.container{padding-top:28px}}
.source-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:12px}.source-card{background:#10130f;border:1px solid #30382c;border-radius:14px;padding:18px;min-width:0}.source-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.source-head h3{font-size:17px;margin:3px 0}.source-url{color:#9da796;font-family:monospace;font-size:13px;overflow-wrap:anywhere;margin:14px 0}.source-actions{display:flex;gap:8px;flex-wrap:wrap}.source-status{font-size:12px;font-weight:700;border-radius:999px;padding:7px 10px;background:#292e27;color:#b9c1b3;overflow-wrap:anywhere;text-align:right}.source-status.ok{background:#102d23;color:#81e6b9}.source-status.warn{background:#352c18;color:#ffd87f}.source-status.bad{background:#3c201e;color:#ffaca6}button:disabled{opacity:.5;cursor:wait}@media(max-width:600px){.source-list{grid-template-columns:1fr}.panelhead{align-items:flex-start;flex-wrap:wrap}}
</style></head><body><header><div class="brand">ELFURA <b> / </b> ROXY</div><div class="pill">● &nbsp;PRIVATE CONTROL ROOM</div></header><main class="container"><section id="login" class="login"><div class="eyebrow">Operator access</div><h1>Welcome back.</h1><p class="muted">Sign in using your configured ELFURA_SECRET.</p><form id="loginForm"><input id="password" type="password" autocomplete="current-password" placeholder="Admin secret" required><button class="primary">Sign in →</button></form><p id="loginError" class="error muted"></p></section><section id="dashboard" class="hidden"><div class="top"><div><div class="eyebrow">Analytics / overview</div><h1>Playback, at a glance.</h1><p class="muted">A live view of your embeds and source health.</p></div><div class="toolbar"><button id="refresh">↻ Refresh</button><button id="clear" class="danger">Clear analytics</button><button id="logout">Sign out</button></div></div><div class="grid"><div class="card"><span>Watching now</span><strong id="watching">—</strong><span>Active in the last minute</span></div><div class="card"><span>Plays today</span><strong id="plays">—</strong><span>Playback starts</span></div><div class="card"><span>Failures today</span><strong id="fails">—</strong><span>Reported by the player</span></div><div class="card"><span>Data window</span><strong>72h</strong><span>Automatically deleted</span></div><div class="card"><span>Server RAM</span><strong id="ramNow">\u2014</strong><span id="ramNote">Payload caching is off, so this should stay flat</span></div></div><div class="layout"><div class="panel full"><div class="panelhead"><div><h2>Playback activity</h2><p class="muted">Hourly starts over the past three days</p></div><span class="tag">LIVE · refreshes every 10s</span></div><div id="chart" class="chart"></div><div class="axis"><span>72 hours ago</span><span>Now</span></div></div><div class="panel"><div class="panelhead"><h2>Most played today</h2><span class="tag">TODAY</span></div><div id="top"></div></div><div class="panel"><div class="panelhead"><h2>Failing titles</h2><span class="tag">LAST 72 HOURS</span></div><div id="failures"></div></div><div class="panel full"><div class="panelhead"><div><h2>Embedding websites</h2><p class="muted">Origin reported by browser referrer. Missing or private referrers appear as unknown.</p></div><span class="tag">LAST 72 HOURS</span></div><div id="sites"></div><div id="banned"></div><p class="notice">Bans are best-effort: referrers can be suppressed or spoofed; direct API use is not site-authenticated. Bans apply to new embed loads.</p></div><div class="panel full"><div class="panelhead"><div><h2>Pop-under ads</h2><p class="muted">Served inside the embed player only. Never on the catalogue, landing page, download page or this panel.</p></div><span class="tag" id="adsState">—</span></div><p class="notice">Always exempt: localhost, private network addresses, theogpiratebot.online and theogpiratebot.to. A site with no referrer never receives an ad either.</p><div class="toolbar"><button id="adsToggle" class="primary">Turn ads off</button><input id="adsSite" placeholder="example.com" style="min-width:220px"><button id="adsAdd">Mark site ad-free</button></div><div id="adsList"></div><p id="adsStatus" class="muted"></p></div><div class="panel full"><div class="panelhead"><div><h2>Source websites</h2><p class="muted">Send an HTTP GET from the Elfura server to each configured website. No requests are sent until you click a button.</p></div><button id="testAll" class="primary">Test all sources</button></div><p class="notice">Online means the website returned an HTTP response. Offline means the request received no response. This does not test video playback.</p><p id="probeStatus" class="muted">No requests sent yet.</p><div id="sources" class="source-list"></div></div><div class="panel full"><div class="panelhead"><div><h2>Source health</h2><p class="muted">Live health per source, read from the resolver. Failures are recorded and shown here; nothing is switched off automatically. A source you switch off here is never called again until you switch it back.</p></div><span class="tag" id="healthState">\u2014</span></div><div class="toolbar"><button id="healthRefresh" class="primary">Refresh health</button></div><p class="notice" id="healthNotice">Failing sources are listed with their last error so you can tell at a glance which provider broke. Nothing is removed automatically \u2014 switching a source off is your decision. Players never lose the connection they already have: a source that goes bad only costs the next lookup, not a stream already playing.</p><div id="sourceHealth" class="source-list"></div></div><div class="panel full"><div class="panelhead"><div><h2>Outbound Proxy Pool</h2><p class="muted">Manage HTTP/HTTPS outbound proxies on this streaming node with live latency, egress IP, and 403/429 telemetry. Changes apply immediately without restarting.</p></div><span class="tag" id="proxyModeTag">DIRECT</span></div><div class="toolbar"><button class="proxy-mode" data-mode="direct">Direct</button><button class="proxy-mode" data-mode="proxy-pool">Proxy Pool</button><button class="proxy-mode" data-mode="hybrid">Hybrid (Fallback Direct)</button></div><div class="grid" style="margin:14px 0"><div class="card"><span>Active proxies</span><strong id="pxActive">0 / 0</strong><span>Enabled &amp; healthy</span></div><div class="card"><span>Proxy requests</span><strong id="pxReqs">0</strong><span>Total routed</span></div><div class="card"><span>Success rate</span><strong id="pxRate">—</strong><span>2xx / 3xx responses</span></div><div class="card"><span>403 / 429 blocks</span><strong id="pxBlocks">0 / 0</strong><span>Upstream refusals</span></div></div><div class="toolbar"><input id="pxLabel" placeholder="Label (e.g. US Res #1)" style="min-width:160px"><input id="pxUrl" placeholder="http://user:pass@host:port" style="min-width:280px" spellcheck="false"><input id="pxWeight" type="number" min="1" max="10" value="1" style="width:70px" title="Weight"><button id="pxAdd" class="primary">+ Add proxy</button></div><p id="pxStatus" class="muted"></p><div id="pxList" class="source-list"></div></div><div class="panel full"><div class="panelhead"><div><h2>Egress relay (Cloudflare Worker)</h2><p class="muted">Preferred. One URL, no per-request cost and no credential to rotate. Deploy <b>cloudflare-worker/worker.js</b> from the download, then paste its URL and token here. Source discovery leaves through Cloudflare instead of the address of this server.</p></div><span class="tag" id="relayState">\u2014</span></div><div class="toolbar"><input id="relayUrl" placeholder="https://elfura-relay.you.workers.dev" style="min-width:320px" spellcheck="false"><input id="relayToken" type="password" placeholder="TOKEN from the Worker" autocomplete="off" style="min-width:200px"><button id="relaySave" class="primary">Save</button><button id="relayTest">Test relay</button><button id="egressTest">Check my server's internet</button><button id="relayClear" class="danger">Remove</button></div><p id="relayStatus" class="muted">No relay set. Elfura connects directly from the address of this server.</p><div id="egressReport"></div></div></div><p id="storage" class="notice"></p></section></main><script>
const $=id=>document.getElementById(id);let signedIn=false;let sourceSites=null;const api=async(path,opts={})=>{const r=await fetch('/roxy/api/'+path,{credentials:'same-origin',cache:'no-store',...opts});let d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d};const post=(path,data)=>api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});
function row(text,count,extra){const div=document.createElement('div');div.className='row';const name=document.createElement('span');name.className='name';name.textContent=text;div.append(name);if(count!==undefined){const n=document.createElement('strong');n.textContent=count;div.append(n)}if(extra)div.append(extra);return div}function list(id,items){const el=$(id);el.replaceChildren(...items);if(!items.length){const p=document.createElement('p');p.className='empty';p.textContent='No data yet.';el.append(p)}}function siteButton(site,banned){const b=document.createElement('button');b.textContent=banned?'Unban':'Ban';b.className=banned?'':'danger';b.onclick=async()=>{if(!confirm((banned?'Unban ':'Ban ')+site+'?'))return;try{await post('ban',{site,ban:!banned});await refresh()}catch(e){alert(e.message)}};return b}
async function refresh(){try{const d=await api('overview');signedIn=true;$('login').classList.add('hidden');$('dashboard').classList.remove('hidden');$('watching').textContent=d.watching;$('plays').textContent=d.playsToday;$('fails').textContent=d.failuresToday;list('top',d.topToday.map(x=>row(x.title ? x.title+' · '+x.key : x.key,x.count)));list('failures',d.failing.map(x=>row(x.title ? x.title+' · '+x.key : x.key,x.count)));list('sites',d.sites.map(x=>row(x.key,x.count,x.key.startsWith('http')?siteButton(x.key,d.bans.includes(x.key)):null)));list('banned',d.bans.filter(x=>!d.sites.some(s=>s.key===x)).map(x=>row(x,undefined,siteButton(x,true))));const max=Math.max(1,...d.hours.map(x=>x.plays));$('chart').replaceChildren(...d.hours.map(x=>{let b=document.createElement('div');b.className='bar';b.style.height=Math.max(2,x.plays/max*100)+'%';b.title=new Date(x.at).toLocaleString()+': '+x.plays+' plays';return b}));$('storage').textContent=d.storageError||'Analytics are deleted after 72 hours. Clear analytics does not remove site bans.';if(!sourceSites)await loadSourceSites();await loadAds();await loadProxies()}catch(e){if(!signedIn){$('dashboard').classList.add('hidden');$('login').classList.remove('hidden')}else $('storage').textContent='Refresh failed: '+e.message}}
$('loginForm').onsubmit=async e=>{e.preventDefault();$('loginError').textContent='';try{await post('login',{password:$('password').value});$('password').value='';await refresh()}catch(err){$('loginError').textContent=err.message}};$('refresh').onclick=refresh;$('logout').onclick=async()=>{await post('logout');signedIn=false;sourceSites=null;$('dashboard').classList.add('hidden');$('login').classList.remove('hidden')};$('clear').onclick=async()=>{if(confirm('Permanently clear all playback analytics? Site bans will remain.')){try{await post('clear');await refresh()}catch(e){alert(e.message)}}};async function copyUrl(url){try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(url)}else{const input=document.createElement('textarea');input.value=url;input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();if(!document.execCommand('copy'))throw Error('Copy failed');input.remove()}}catch(e){alert('Could not copy. Website: '+url)}}
async function loadSourceSites(){const d=await api('source-websites');sourceSites=d.sites;const cards=sourceSites.map(site=>{const card=document.createElement('div');card.className='source-card';const head=document.createElement('div');head.className='source-head';const title=document.createElement('h3');title.textContent=site.name+' · '+site.source;const status=document.createElement('span');status.id='result-'+site.id;status.className='source-status';status.textContent='NOT TESTED';head.append(title,status);const url=document.createElement('p');url.className='source-url';url.textContent=site.url;const actions=document.createElement('div');actions.className='source-actions';const copy=document.createElement('button');copy.textContent='Copy';copy.onclick=()=>copyUrl(site.url);const open=document.createElement('button');open.textContent='Open';open.onclick=()=>{try{const u=new URL(site.url);if(u.protocol==='http:'||u.protocol==='https:')window.open(u.href,'_blank','noopener,noreferrer')}catch(e){alert('Invalid website URL')}};const test=document.createElement('button');test.textContent='Test';test.className='sourceRequest';test.id='button-'+site.id;test.onclick=()=>requestSites(site.id);actions.append(copy,open,test);card.append(head,url,actions);return card});$('sources').replaceChildren(...cards)}
async function requestSites(id){if(!sourceSites)return;const buttons=document.querySelectorAll('.sourceRequest, #testAll');buttons.forEach(b=>b.disabled=true);const selected=id==='all'?sourceSites:sourceSites.filter(s=>s.id===id);selected.forEach(s=>{const el=$('result-'+s.id);el.className='source-status';el.textContent='TESTING…'});$('probeStatus').textContent='Sending HTTP requests from your server…';try{const d=await post('source-websites/request',{id});d.results.forEach(r=>{const el=$('result-'+r.id);el.textContent=r.status?'ONLINE · HTTP '+r.status+' · '+r.ms+' MS':'OFFLINE · '+r.error+' · '+r.ms+' MS';el.className='source-status '+(r.status?'ok':'bad');$('button-'+r.id).textContent='Retest'});$('probeStatus').textContent='Last test '+new Date().toLocaleTimeString()+'. Online means an HTTP response was received.'}catch(e){selected.forEach(s=>{const el=$('result-'+s.id);el.className='source-status bad';el.textContent='REQUEST NOT COMPLETED'});$('probeStatus').textContent=e.message}finally{buttons.forEach(b=>b.disabled=false)}}$('testAll').onclick=()=>requestSites('all');const adsState={enabled:true,adFreeSites:[],alwaysAdFree:[]};async function loadAds(){try{const d=await api('ads');adsState.enabled=d.enabled;adsState.adFreeSites=d.adFreeSites||[];adsState.alwaysAdFree=d.alwaysAdFree||[];$('adsState').textContent=d.enabled?'ADS ON · PLAYER ONLY':'ADS OFF';$('adsToggle').textContent=d.enabled?'Turn ads off':'Turn ads on';const seen=(d.sitesSeen||[]).filter(x=>x&&x.indexOf('http')===0).map(x=>{try{return new URL(x).hostname.replace(/^www\./,'')}catch(e){return ''}}).filter(Boolean);const all=[...new Set([...seen,...adsState.adFreeSites])];$('adsList').replaceChildren(...all.map(host=>{const free=adsState.adFreeSites.includes(host);const forced=adsState.alwaysAdFree.some(a=>host===a||host.endsWith('.'+a));return row(host,undefined,siteButton2(host,free,forced))}));if(!all.length)$('adsList').replaceChildren(row('No embedding sites seen yet',undefined,null));}catch(e){$('adsStatus').textContent='Ads settings unavailable: '+e.message}}function siteButton2(host,free,forced){const b=document.createElement('button');b.textContent=forced?'ALWAYS FREE':free?'AD-FREE · TURN ON':'ADS ON · MAKE FREE';b.disabled=forced;if(free)b.className='primary';b.onclick=async()=>{try{await post('ads',{site:host,adFree:!free});$('adsStatus').textContent=host+(free?' will show ads again.':' is now ad-free.');await loadAds()}catch(e){$('adsStatus').textContent=e.message}};return b}$('adsAdd').onclick=async()=>{const v=($('adsSite').value||'').trim();if(!v)return;try{await post('ads',{site:v,adFree:true});$('adsSite').value='';$('adsStatus').textContent=v+' marked ad-free.';await loadAds()}catch(e){$('adsStatus').textContent=e.message}};$('adsToggle').onclick=async()=>{try{await post('ads',{enabled:!adsState.enabled});await loadAds();$('adsStatus').textContent=adsState.enabled?'Ads are on for eligible sites.':'Ads are off everywhere.'}catch(e){$('adsStatus').textContent=e.message}};$('relayClear').onclick=async()=>{if(!confirm('Remove the relay? Elfura will connect directly again.'))return;try{await post('relay',{clear:true});$('relayUrl').value='';$('relayToken').value='';$('relayStatus').textContent='Relay removed; connecting directly.';await loadRelay()}catch(e){$('relayStatus').textContent=e.message}};
loadRelay().catch(()=>{});
function renderRam(m){if(!m)return;const el=$('ramNow');if(!el)return;el.textContent=m.rssMb+' MB';const note=$('ramNote');if(note)note.textContent=(m.payloadCaches==='off'?'Caching off \u00b7 live heap ':'Caching on \u00b7 live heap ')+m.heapUsedMb+' MB';$('ramNote')&&0}
async function loadRam(){try{const r=await fetch('/api/v1/health',{headers:{Accept:'application/json'}});const d=await r.json();renderRam(d.memory)}catch{}}

async function loadHealth(){
  const box=$('sourceHealth'),state=$('healthState'),note=$('healthNotice');
  if(!box)return;
  let d;
  try{ d=await api('sources'); }catch(e){ if(state)state.textContent='UNAVAILABLE';
    if(note)note.textContent='Could not read source health: '+e.message; return; }
  const r=d.resolver||{};
  if(state)state.textContent= r.reachable ? 'RESOLVER · '+String(r.label||'').toUpperCase() : 'RESOLVER OFFLINE';
  if(d.unavailable){
    if(note)note.textContent='The source resolver is not reachable right now ('+(r.detail||'no answer')+'). '
      +'Video that is already playing keeps playing; only new lookups wait until it is back.';
    box.replaceChildren();
    return;
  }
  if(note)note.textContent='Resolving '+(r.kind==='local'?'in this process':'in a separate resolver process ('
    +String(r.sources?r.sources.length:0)+' sources)')+'. Resting sources are retried automatically; '
    +'switched-off sources are not called at all.';
  const list=Array.isArray(d.sources)?d.sources:[];
  if(!list.length){ box.replaceChildren(); return; }
  box.replaceChildren(...list.map(src=>{
    const card=document.createElement('div');card.className='source-card';
    const head=document.createElement('div');head.className='source-head';
    const title=document.createElement('h3');title.textContent=src.label+' · '+src.id;
    const dot=document.createElement('span');dot.className='source-status';
    // Only two states exist: you switched it off, or it is still being used.
    // "failing" is shown in the detail line, not as a state, because a failing
    // source is still in rotation by design.
    const bad=src.disabledByOperator;
    dot.textContent=bad?'SWITCHED OFF':(src.consecutiveFailures?'FAILING':'OK');
    dot.style.color=bad?'#e08a6a':'#8fd694';
    head.append(title,dot);
    const detail=document.createElement('p');detail.className='source-url';
    detail.textContent=src.detail+(src.lastError?' · last error: '+src.lastError:'')
      +(src.consecutiveFailures?' · '+src.consecutiveFailures+' failure(s) in a row':'');
    const actions=document.createElement('div');actions.className='source-actions';
    const toggle=document.createElement('button');
    toggle.textContent=src.disabledByOperator?'Switch back on':'Switch off';
    if(!src.disabledByOperator)toggle.className='danger';
    toggle.onclick=async()=>{
      toggle.disabled=true;
      try{ await api('sources',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id:src.id,enabled:!!src.disabledByOperator})}); await loadHealth(); }
      catch(e){ toggle.disabled=false; alert('Could not change '+src.id+': '+e.message); }
    };
    actions.append(toggle);
    card.append(head,detail,actions);
    return card;
  }));
}
async function loadSourceHealth(){ if(!signedIn)return; await loadHealth(); }
if($('healthRefresh'))$('healthRefresh').onclick=()=>loadHealth();

loadRam();setInterval(loadRam,15000);
loadSourceHealth();setInterval(loadSourceHealth,20000);
loadAds();refresh();setInterval(()=>{if(signedIn)refresh()},10000);

function renderProxyPool(pool){
  if(!pool)return;
  const s=pool.summary||{};
  if($('proxyModeTag'))$('proxyModeTag').textContent=String(pool.mode||'direct').toUpperCase();
  document.querySelectorAll('.proxy-mode').forEach(btn=>{
    btn.classList.toggle('primary',btn.dataset.mode===pool.mode);
  });
  if($('pxActive'))$('pxActive').textContent=(s.healthy||0)+' / '+(s.total||0);
  if($('pxReqs'))$('pxReqs').textContent=String(s.requests||0);
  const rate=s.requests>0?Math.round((s.successes/s.requests)*100)+'%':'—';
  if($('pxRate'))$('pxRate').textContent=rate;
  if($('pxBlocks'))$('pxBlocks').textContent=(s.status403||0)+' / '+(s.status429||0);
  const box=$('pxList');if(!box)return;
  const list=Array.isArray(pool.proxies)?pool.proxies:[];
  if(!list.length){
    const p=document.createElement('p');p.className='muted';p.textContent='No proxies added yet. Add one above to route outbound traffic.';
    box.replaceChildren(p);return;
  }
  box.replaceChildren(...list.map(px=>{
    const card=document.createElement('div');card.className='source-card';
    const head=document.createElement('div');head.className='source-head';
    const title=document.createElement('h3');title.textContent=px.label+' ('+px.maskedUrl+')';
    const dot=document.createElement('span');dot.className='source-status';
    dot.textContent=!px.enabled?'Disabled':(px.stats.healthy?'Healthy':'Degraded');
    dot.style.color=!px.enabled?'var(--muted)':(px.stats.healthy?'#4ade80':'#f87171');
    head.append(title,dot);
    const meta=document.createElement('p');meta.className='muted';
    const lat=px.stats.lastLatencyMs!=null?(px.stats.lastLatencyMs+'ms (avg '+px.stats.avgLatencyMs+'ms)'):'untested';
    const ip=px.stats.lastEgressIp?('IP: '+px.stats.lastEgressIp):'IP: —';
    meta.textContent=ip+' · Latency: '+lat+' · Req: '+px.stats.requests+' (OK '+px.stats.successes+' / 403:'+px.stats.status403+' / 429:'+px.stats.status429+')'+(px.stats.lastError?' · Last: '+px.stats.lastError:'');
    const bar=document.createElement('div');bar.className='toolbar';bar.style.marginTop='8px';
    const testBtn=document.createElement('button');testBtn.textContent='Test';
    testBtn.onclick=async()=>{
      testBtn.disabled=true;testBtn.textContent='Testing...';
      const r=await fetch('/roxy/api/proxies/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:px.id})});
      const d=await r.json().catch(()=>({}));
      if($('pxStatus'))$('pxStatus').textContent=d.ok?(px.label+': OK ('+d.result.latencyMs+'ms, IP '+(d.result.egressIp||'unknown')+')'):(px.label+': Failed ('+(d.result?.error||'error')+')');
      if(d.pool)renderProxyPool(d.pool);
    };
    const togBtn=document.createElement('button');togBtn.textContent=px.enabled?'Disable':'Enable';
    togBtn.onclick=async()=>{
      const r=await fetch('/roxy/api/proxies/toggle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:px.id,enabled:!px.enabled})});
      const d=await r.json().catch(()=>({}));if(d.pool)renderProxyPool(d.pool);
    };
    const delBtn=document.createElement('button');delBtn.className='danger';delBtn.textContent='Delete';
    delBtn.onclick=async()=>{
      const r=await fetch('/roxy/api/proxies/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:px.id})});
      const d=await r.json().catch(()=>({}));if(d.pool)renderProxyPool(d.pool);
    };
    bar.append(testBtn,togBtn,delBtn);
    card.append(head,meta,bar);
    return card;
  }));
}
async function loadProxies(){
  if(!signedIn)return;
  const r=await fetch('/roxy/api/proxies');
  if(r.ok)renderProxyPool(await r.json());
}
document.querySelectorAll('.proxy-mode').forEach(btn=>{
  btn.onclick=async()=>{
    const r=await fetch('/roxy/api/proxies/mode',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:btn.dataset.mode})});
    const d=await r.json().catch(()=>({}));if(d.pool)renderProxyPool(d.pool);
  };
});
if($('pxAdd'))$('pxAdd').onclick=async()=>{
  const url=($('pxUrl')?.value||'').trim();
  const label=($('pxLabel')?.value||'').trim();
  const weight=Number($('pxWeight')?.value||1);
  if(!url){if($('pxStatus'))$('pxStatus').textContent='Enter a proxy URL (http://user:pass@host:port)';return;}
  const r=await fetch('/roxy/api/proxies',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label,url,weight})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){if($('pxStatus'))$('pxStatus').textContent=d.error||'Failed to add proxy';return;}
  if($('pxUrl'))$('pxUrl').value='';if($('pxLabel'))$('pxLabel').value='';
  if($('pxStatus'))$('pxStatus').textContent='Proxy added.';
  if(d.pool)renderProxyPool(d.pool);
};
loadProxies();setInterval(loadProxies,3000);
</script></body></html>`;
