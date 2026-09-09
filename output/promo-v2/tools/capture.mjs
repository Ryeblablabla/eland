import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const base=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
for (const directory of ['qa', 'shots']) fs.mkdirSync(path.join(base, directory), {recursive:true});
const [shot='walk',mode='preview',durationArg]=process.argv.slice(2);
const target=await fetch('http://127.0.0.1:9332/json/new?about:blank',{method:'PUT'}).then(r=>r.json());
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
let serial=0;const requests=new Map(),errors=[];
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++serial;requests.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));})}
ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){const p=requests.get(m.id);requests.delete(m.id);if(m.error)p?.reject(m.error);else p?.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);};
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await send('Page.enable');await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:2560,height:1440,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:'http://127.0.0.1:3217/.promo/?shot='+encodeURIComponent(shot)});
let ready=false;
for(let i=0;i<300;i++){await sleep(200);ready=await evaluate('Boolean(window.__director?.ready)');if(ready)break;if(errors.length)throw new Error(errors.join('\n'));}
if(!ready)throw new Error('Director not ready '+errors.join('\n'));
const info=await evaluate('window.__director.getInfo()');
const duration=Number(durationArg||info.spec.duration);
console.log(JSON.stringify({shot,mode,duration,info}));
const getFrame=async time=>{
 if(info.spec.dialogue||info.spec.memory){await evaluate(`window.__director.render(${time})`);const r=await send('Page.captureScreenshot',{format:'jpeg',quality:98,captureBeyondViewport:false,fromSurface:true});return Buffer.from(r.data,'base64');}
 const r=await evaluate(`window.__director.frame(${time})`);return Buffer.from(r.jpeg,'base64');
};
if(mode==='preview'){
 for(const [i,time]of [0,duration*.4,duration*.85].entries()){
  // Warm up the official environment at 30 fps, never substitute a static still.
  const prev=i===0?0:(i===1?0:duration*.4);for(let t=prev;t<time;t+=1/30)await evaluate(`window.__director.render(${t})`);
  const bytes=await getFrame(time);fs.writeFileSync(path.join(base,'qa',`${shot}-${i}.jpg`),bytes);
 }
 console.log('preview saved');
}else{
 const count=Math.round(duration*30),out=path.join(base,'shots',`${shot}.mp4`);
 const ff=spawn('ffmpeg',['-hide_banner','-loglevel','warning','-y','-f','image2pipe','-vcodec','mjpeg','-framerate','30','-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','14','-threads','4','-pix_fmt','yuv420p','-movflags','+faststart',out],{stdio:['pipe','ignore','pipe']});
 let stderr='';ff.stderr.on('data',d=>{stderr+=d.toString()});
 const started=Date.now();
 for(let i=0;i<count;i++){
  const bytes=await getFrame(i/30);
  if(!ff.stdin.write(bytes))await once(ff.stdin,'drain');
  if(i===0||i===Math.floor(count/2)||i===count-1)fs.writeFileSync(path.join(base,'qa',`${shot}-frame-${i}.jpg`),bytes);
  if(i%60===0)console.log(`${shot}: ${i}/${count} frames, ${(Date.now()-started)/1000}s`);
 }
 ff.stdin.end();const [code]=await once(ff,'close');if(code!==0)throw new Error(stderr);
 fs.writeFileSync(path.join(base,'shots',`${shot}.json`),JSON.stringify({shot,duration,fps:30,width:2560,height:1440,frames:count,renderedFrames:count,method:'official renderer, explicit presentation clock, one native render per encoded frame',source:info,errors},null,2));
 console.log(`${shot}: complete ${count} native frames`);
}
await send('Page.close');ws.close();
