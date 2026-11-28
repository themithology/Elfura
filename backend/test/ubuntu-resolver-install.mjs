// Exercises installer preservation, service configuration and failure handling
// without root, systemd, apt or network access. Actual ZIP startup is tested separately.
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync} from 'node:fs';
import {execFileSync, spawnSync, spawn} from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
const root=process.cwd(), tmp=mkdtempSync(path.join(os.tmpdir(),'elfura-installer-test-'));
try {
 const bin=path.join(tmp,'bin'), dir=path.join(tmp,'vps'), dest=path.join(tmp,'install'), unit=path.join(tmp,'elfura.service');
 mkdirSync(bin);mkdirSync(dir);
 const command=(name,body)=>{let f=path.join(bin,name);writeFileSync(f,`#!/bin/bash\nset -e\n${body}\n`);chmodSync(f,0o755);};
 command('id','if [ "${1:-}" = -u ]; then echo 0; fi');
 command('systemctl','exit 0'); command('useradd','exit 0');command('chown','exit 0');
 command('install','args=(); while (($#)); do if [[ "$1" = -o || "$1" = -g ]]; then shift 2; else args+=("$1"); shift; fi; done; exec /usr/bin/install "${args[@]}"');
 command('curl','out=""; while (($#)); do if [ "$1" = -o ]; then out="$2"; shift 2; else shift; fi; done; if [ -n "$out" ]; then /bin/cp "$MOCK_ZIP" "$out"; else echo \'{"ok":true,"service":"elfura-resolver"}\'; fi');
 const script=readFileSync(path.join(root,'scripts/install-ubuntu-resolver.sh'),'utf8')
  .replace('DEST=/opt/elfura-resolver',`DEST=${dest}`).replace('UNIT=/etc/systemd/system/elfura-resolver.service',`UNIT=${unit}`)
  .replaceAll('/usr/bin/node',process.execPath);
 const installer=path.join(tmp,'install.sh');writeFileSync(installer,script);
 const env={...process.env,PATH:`${bin}:${process.env.PATH}`,MOCK_ZIP:path.join(root,'elfura-pterodactyl.zip')};
 const secret='test-secret-0123456789-abcdef';
 const original=`ELFURA_SECRET=${secret}\nELFURA_RESOLVER_OPEN=1\n`;
 writeFileSync(path.join(dir,'.env'),original);
 let r=spawnSync('bash',[installer],{cwd:dir,env,encoding:'utf8',timeout:30000});
 assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`);
 assert(!r.stdout.includes(secret) && !r.stderr.includes(secret),'installer leaked secret');
 assert.equal(readFileSync(path.join(dest,'.env'),'utf8'),original);
 const sourceManifest=readFileSync(path.join(dest,'dist/backend/sources/index.js'),'utf8');
 assert.deepEqual([...sourceManifest.matchAll(/id: 'source-(\\d+)'/g)].map(match=>`source-${match[1]}`),['source-1','source-2','source-3','source-4']);
 const service=readFileSync(unit,'utf8');
 for(const required of ['ELFURA_RESOLVER_LISTEN=127.0.0.1','ELFURA_RESOLVER_PORT=3002','ELFURA_RESOLVER_OPEN=0','--resolver','Restart=on-failure']) assert(service.includes(required),required);
 writeFileSync(path.join(dest,'data','keep.json'),'persistent');
 writeFileSync(path.join(dir,'.env'),'ELFURA_SECRET=a-different-secret-0123456789\n');
 r=spawnSync('bash',[installer],{cwd:dir,env,encoding:'utf8',timeout:30000});
 assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`);
 assert.equal(readFileSync(path.join(dest,'.env'),'utf8'),original,'update overwrote .env');
 assert.equal(readFileSync(path.join(dest,'data','keep.json'),'utf8'),'persistent','update overwrote data');
 writeFileSync(path.join(dest,'.env'),'ELFURA_SECRET=change-me\n');
 r=spawnSync('bash',[installer],{cwd:dir,env,encoding:'utf8',timeout:30000});
 assert.notEqual(r.status,0,'must reject weak config');
 // Start the real packaged resolver with the systemd overrides. Even though
 // .env says OPEN=1, a localhost request without the token must be rejected.
 const real=path.join(tmp,'real');mkdirSync(real);
 execFileSync('unzip',['-oq',path.join(root,'elfura-pterodactyl.zip'),'-d',real]);
 writeFileSync(path.join(real,'.env'),original);
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));
 const port=socket.address().port;await new Promise(r=>socket.close(r));
 const runtime={...process.env,ELFURA_RESOLVER_MODE:'1',ELFURA_RESOLVER_OPEN:'0',ELFURA_RESOLVER_LISTEN:'127.0.0.1',ELFURA_RESOLVER_PORT:String(port),ELFURA_SUPERVISE:'0',NODE_ENV:'production'};
 delete runtime.ELFURA_SECRET;delete runtime.ELFURA_RESOLVER_TOKEN;
 const child=spawn(process.execPath,['index.js','--resolver'],{cwd:real,env:runtime,stdio:'ignore',detached:true});
 try {
  const base=`http://127.0.0.1:${port}`;let healthy=false;
  for(let i=0;i<60;i++){
   try {const response=await fetch(`${base}/resolver/api/health`);if(response.ok&&(await response.json()).ok){healthy=true;break;}}catch{}
   await new Promise(r=>setTimeout(r,100));
  }
  assert(healthy,'packaged resolver did not become healthy');
  assert.equal((await fetch(`${base}/resolver/api/sources`)).status,401,'proxy loopback must not bypass authentication');
  assert.equal((await fetch(`${base}/resolver/api/sources`,{headers:{'x-elfura-resolver-token':secret}})).status,200);
 } finally {try{process.kill(-child.pid,'SIGTERM');}catch{};await new Promise(r=>{if(child.exitCode!==null)r();else child.once('exit',r);});}
 console.log('Ubuntu resolver installer: authenticated loopback unit, packaged startup, upgrade preservation and weak-secret rejection OK');
} finally {rmSync(tmp,{recursive:true,force:true});}
