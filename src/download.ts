import './download.css';
type Item = {name:string;quality:string;size:string;languages:string[];kind:string;ticket:string};
const $ = <T extends HTMLElement>(selector:string) => document.querySelector<T>(selector)!;
const form = $<HTMLFormElement>('#search'), kind=$<HTMLSelectElement>('#kind'), tmdb=$<HTMLInputElement>('#tmdb'), season=$<HTMLInputElement>('#season'), episode=$<HTMLInputElement>('#episode');
const status=$<HTMLElement>('#status'), results=$<HTMLElement>('#results'), files=$<HTMLElement>('#files'), langs=$<HTMLElement>('#languages');
let items:Item[]=[]; let selected='';
function statusText(text:string,error=false){status.textContent=text;status.dataset.error=String(error);}
function syncType(){document.querySelectorAll<HTMLElement>('.tv-field').forEach(el=>el.hidden=kind.value!=='tv');}
kind.addEventListener('change',syncType);
function render(){
  langs.replaceChildren();files.replaceChildren();
  const labels=[...new Set(items.flatMap(item=>item.languages))];
  if (!labels.includes(selected)) selected=labels[0]||'';
  for(const label of labels){const b=document.createElement('button');b.type='button';b.className='language';b.textContent=label;b.setAttribute('aria-pressed',String(label===selected));b.onclick=()=>{selected=label;render();};langs.append(b);}
  const matching=items.filter(item=>item.languages.includes(selected));
  $('#count').textContent=`${matching.length} FILE${matching.length===1?'':'S'}`;
  for(const item of matching){
    const row=document.createElement('article');row.className='file-row';const info=document.createElement('div');info.className='file-info';const name=document.createElement('strong');name.textContent=item.name;const meta=document.createElement('div');meta.className='file-meta';
    for(const value of [item.quality,item.size,item.languages.join(' + '),item.kind]){if(!value)continue;const tag=document.createElement('span');tag.className='tag';tag.textContent=value;meta.append(tag);}
    info.append(name,meta);const link=document.createElement('a');link.textContent='View download ↗';link.href=`/dl/file?t=${encodeURIComponent(item.ticket)}`;row.append(info,link);files.append(row);
  }
}
form.addEventListener('submit',async event=>{
  event.preventDefault();if(!form.reportValidity())return;results.hidden=true;items=[];selected='';statusText('Finding available files…');const button=form.querySelector<HTMLButtonElement>('button[type=submit]')!;button.disabled=true;
  try{const params=new URLSearchParams({type:kind.value,tmdb:tmdb.value});if(kind.value==='tv'){params.set('season',season.value);params.set('episode',episode.value);}const res=await fetch(`/dl/api/resolve?${params}`);const data=await res.json() as {ok:boolean;items?:Item[];error?:string};if(!res.ok||!data.ok)throw Error(data.error||'Could not find files right now.');items=data.items||[];if(!items.length){statusText('No download files found right now. Try again later.',true);return;}statusText('Choose a language to see available files.');results.hidden=false;render();}catch(e){statusText(e instanceof Error?e.message:'Could not find files right now.',true);}finally{button.disabled=false;}
});
const parts=location.pathname.replace(/\/+$/,'').split('/');
if(parts[2]==='file'){
  $('.intro').hidden=true;$('.workspace:not(.file-page)').hidden=true;const page=$<HTMLElement>('#file-page');page.hidden=false;
  const ticket=new URLSearchParams(location.search).get('t')||'';const error=$<HTMLElement>('#file-error');const dl=$<HTMLAnchorElement>('#download');
  dl.hidden=true;$('#file-name').textContent='Checking your link…';
  void fetch(`/dl/api/file?t=${encodeURIComponent(ticket)}`).then(async r=>{const d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'This link is unavailable.');$('#file-name').textContent=d.name;$('#file-meta').textContent=[d.quality,d.size,d.languages,d.kind].filter(Boolean).join('  ·  ');dl.href=`/dl/go?t=${encodeURIComponent(ticket)}`;dl.hidden=false;}).catch(e=>{error.textContent=e.message;$('#file-name').textContent='Link unavailable';});
  $('#copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(location.href);error.textContent='Page link copied.';}catch{error.textContent='Copy the page address from your browser.';}});
}else if(parts[2]==='movie'&&/^\d+$/.test(parts[3]||'')){kind.value='movie';tmdb.value=parts[3];syncType();form.requestSubmit();}
else if(parts[2]==='tv'&&/^\d+$/.test(parts[3]||'')){kind.value='tv';tmdb.value=parts[3];season.value=parts[4]||'1';episode.value=parts[5]||'1';syncType();form.requestSubmit();}
