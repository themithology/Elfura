/** Private, bounded operator analytics. No addresses, paths, cookies or stream URLs are stored. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RETENTION = 3 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 50_000;
type Event = { at: number; kind: 'play' | 'failure'; site: string; type: 'movie' | 'tv'; tmdb: string; title?: string };
type Ticket = { id: string; site: string; type: 'movie' | 'tv'; tmdb: string; exp: number };

export function siteOrigin(value: unknown): string {
  try { const u = new URL(String(value)); return ['http:', 'https:'].includes(u.protocol) ? u.origin.toLowerCase() : ''; } catch { return ''; }
}
export class RoxyStore {
  private events: Event[] = [];
  private bans = new Set<string>();
  private viewers = new Map<string, number>();
  private played = new Map<string, number>();
  private failed = new Map<string, number>();
  private file: string;
  private timer: ReturnType<typeof setInterval>;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private storageError = '';
  constructor(private secret: Buffer, directory = process.env.ROXY_DATA_DIR || path.join(process.cwd(), 'data')) {
    this.file = path.join(directory, 'roxy.json');
    try {
      const obj = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { events?: Event[]; bans?: string[] };
      if (Array.isArray(obj.events)) this.events = obj.events.filter(e => e && Number.isFinite(e.at) && (e.kind === 'play' || e.kind === 'failure') && typeof e.tmdb === 'string' && typeof e.site === 'string').slice(-MAX_EVENTS);
      if (Array.isArray(obj.bans)) this.bans = new Set(obj.bans.map(siteOrigin).filter(Boolean).slice(0, 5000));
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.storageError = 'Could not read analytics storage'; }
    if (this.prune()) this.save();
    this.timer = setInterval(() => { if (this.prune()) this.save(); }, 60_000); this.timer.unref();
  }
  private prune(now = Date.now()): boolean {
    const before = this.events.length;
    this.events = this.events.filter(e => e.at > now - RETENTION);
    for (const [id, at] of this.viewers) if (at < now - 60_000) this.viewers.delete(id);
    for (const map of [this.played, this.failed]) for (const [id, exp] of map) if (exp < now) map.delete(id);
    return before !== this.events.length;
  }
  private save() {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      const snapshot = JSON.stringify({events:this.events,bans:[...this.bans]});
      this.writing = this.writing.then(async () => {
        try { await fs.promises.mkdir(path.dirname(this.file), {recursive:true,mode:0o700}); const tmp = this.file + '.tmp'; await fs.promises.writeFile(tmp, snapshot, {mode:0o600}); await fs.promises.rename(tmp, this.file); this.storageError = ''; }
        catch { this.storageError = 'Could not persist analytics'; }
      });
    }, 250); this.pending.unref();
  }
  async flush() {
    if (this.pending) { clearTimeout(this.pending); this.pending = null; }
    const snapshot=JSON.stringify({events:this.events,bans:[...this.bans]});
    this.writing=this.writing.then(async()=>{try {await fs.promises.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});const tmp=this.file+'.tmp';await fs.promises.writeFile(tmp,snapshot,{mode:0o600});await fs.promises.rename(tmp,this.file);this.storageError='';}catch{this.storageError='Could not persist analytics';}});
    await this.writing;
    return !this.storageError;
  }
  close() { clearInterval(this.timer); if (this.pending) { clearTimeout(this.pending); this.pending = null; void this.flush(); } }
  isBanned(site: string) { return !!site && this.bans.has(siteOrigin(site)); }
  setBan(site: string, ban: boolean) { const origin = siteOrigin(site); if (!origin) return false; if (ban) this.bans.add(origin); else this.bans.delete(origin); this.save(); return true; }
  clear() { this.events = []; this.viewers.clear(); this.played.clear(); this.failed.clear(); this.save(); }
  ticket(site: string, type: 'movie' | 'tv', tmdb: string) {
    const payload = Buffer.from(JSON.stringify({id:crypto.randomBytes(16).toString('hex'),site:siteOrigin(site),type,tmdb,exp:Date.now()+6*60*60_000} satisfies Ticket)).toString('base64url');
    return payload+'.'+crypto.createHmac('sha256',this.secret).update('roxy-event:'+payload).digest('base64url');
  }
  record(token: unknown, kind: unknown, rawTitle?: unknown): boolean {
    if (typeof token !== 'string' || token.length > 2048 || !['play','heartbeat','stop','failure'].includes(String(kind))) return false;
    const [payload, sig, extra] = token.split('.'); if (!payload || !sig || extra) return false;
    const expected=crypto.createHmac('sha256',this.secret).update('roxy-event:'+payload).digest();
    let got: Buffer; try { got=Buffer.from(sig,'base64url'); } catch { return false; }
    if (got.length!==expected.length || !crypto.timingSafeEqual(got,expected)) return false;
    let t: Ticket; try { t=JSON.parse(Buffer.from(payload,'base64url').toString()); } catch { return false; }
    if (!t.id || !/^[a-f0-9]{32}$/.test(t.id) || !/^[A-Za-z0-9_-]{1,24}$/.test(t.tmdb) || !['movie','tv'].includes(t.type) || !Number.isFinite(t.exp) || t.exp < Date.now() || this.isBanned(t.site)) return false;
    const now=Date.now(); this.prune(now);
    const title=typeof rawTitle === 'string' ? rawTitle.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0,120) : '';
    if (kind==='stop') { this.viewers.delete(t.id); return true; }
    if (kind==='play' || kind==='heartbeat') {
      this.viewers.set(t.id,now);
      if (!this.played.has(t.id)) { this.played.set(t.id,t.exp); this.events.push({at:now,kind:'play',site:t.site,type:t.type,tmdb:t.tmdb,...(title ? {title} : {})}); this.save(); }
    } else if (kind==='failure' && !this.failed.has(t.id)) { this.failed.set(t.id,t.exp); this.events.push({at:now,kind:'failure',site:t.site,type:t.type,tmdb:t.tmdb,...(title ? {title} : {})}); this.save(); }
    if (this.events.length>MAX_EVENTS) this.events.splice(0,this.events.length-MAX_EVENTS);
    for (const map of [this.played, this.failed]) while (map.size>MAX_EVENTS) map.delete(map.keys().next().value!);
    while (this.viewers.size>MAX_EVENTS) this.viewers.delete(this.viewers.keys().next().value!);
    return true;
  }
  snapshot() {
    if(this.prune()) this.save(); const now=Date.now(); const today=new Date(); today.setHours(0,0,0,0);
    const groups=(kind:'play'|'failure', start:number, bySite=false) => { const counts=new Map<string,number>(); for(const e of this.events) if(e.kind===kind && e.at>=start){const k=bySite?(e.site||'(direct / unknown)'):`${e.type}:${e.tmdb}`;counts.set(k,(counts.get(k)||0)+1)} return [...counts].map(([key,count])=>({key,count,title:bySite ? '' : [...this.events].reverse().find(e=>`${e.type}:${e.tmdb}`===key && e.title)?.title || ''})).sort((a,b)=>b.count-a.count).slice(0,100); };
    const hours=Array.from({length:72},(_,i)=>{const at=Math.floor(now/3600000)*3600000-(71-i)*3600000;return {at,plays:this.events.filter(e=>e.kind==='play'&&e.at>=at&&e.at<at+3600000).length};});
    return {now, watching:this.viewers.size, playsToday:this.events.filter(e=>e.kind==='play'&&e.at>=today.getTime()).length, failuresToday:this.events.filter(e=>e.kind==='failure'&&e.at>=today.getTime()).length,topToday:groups('play',today.getTime()),failing:groups('failure',now-RETENTION),sites:groups('play',now-RETENTION,true),hours,bans:[...this.bans],storageError:this.storageError,retentionHours:72};
  }
}
