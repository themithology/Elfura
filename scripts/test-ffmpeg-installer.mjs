// Test deployment only: asynchronously provision a pinned FFmpeg package.
// Playback starts independently even if this fails. No lifecycle scripts run.
import {createReadStream} from 'node:fs';
import {access, chmod, mkdir, mkdtemp, rename, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const dir=path.join(root,'vendor','ffmpeg');const dest=path.join(dir,'ffmpeg');
const integrity='vkW3BmOLGgPYrg6XfMlXnO/j6N6zd21Kj2YUvk02PVj6Cm+1c9zJSY28V96y7biKm127CqVRTMwd9o3zH+s6fQ==';
const run=(program,args)=>new Promise((resolve,reject)=>{
  const p=spawn(program,args,{stdio:'ignore',env:{...process.env,npm_config_audit:'false',npm_config_fund:'false'}});
  const timer=setTimeout(()=>p.kill('SIGKILL'),180_000);timer.unref();
  p.once('error',e=>{clearTimeout(timer);reject(e);});p.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error(`${program} failed`));});
});
export async function installTestFfmpeg(){
  if(process.env.ELFURA_FFMPEG_PATH) return;
  if(process.platform!=='linux'||process.arch!=='x64'){console.error('[download-test] Automatic FFmpeg installer supports Linux x64 only; playback is unaffected.');return;}
  try{await access(dest,1);console.log('[download-test] FFmpeg already installed.');return;}catch{}
  let tmp;
  try {
    await mkdir(dir,{recursive:true});tmp=await mkdtemp(path.join(dir,'.install-'));
    console.log('[download-test] Installing FFmpeg in the background. Playback is available while this runs.');
    await run('npm',['pack','@backendsuraj/offline-ffmpeg-linux-x64@8.0.2','--pack-destination',tmp,'--ignore-scripts','--no-audit','--no-fund']);
    const archive=path.join(tmp,'backendsuraj-offline-ffmpeg-linux-x64-8.0.2.tgz');const hash=createHash('sha512');
    for await(const chunk of createReadStream(archive))hash.update(chunk);
    if(hash.digest('base64')!==integrity)throw Error('Package integrity mismatch');
    await run('tar',['-xzf',archive,'-C',tmp,'package/bin/ffmpeg']);
    const binary=path.join(tmp,'package','bin','ffmpeg');await chmod(binary,0o755);await rename(binary,dest);
    console.log('[download-test] FFmpeg is ready.');
  }catch(e){console.error('[download-test] FFmpeg installation failed. Downloads remain unavailable; playback is unaffected.');}
  finally {if(tmp)await rm(tmp,{recursive:true,force:true}).catch(()=>{});}
}
