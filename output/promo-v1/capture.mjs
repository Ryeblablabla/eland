import fs from 'node:fs';
import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
for (const directory of ['qa', 'source']) fs.mkdirSync(path.join(root, directory), {recursive:true});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const target = await fetch('http://127.0.0.1:9331/json/new?about:blank', {method:'PUT'}).then(r=>r.json());
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
let id=0; const pending=new Map(); let recording=null;
function send(method,params={}) {return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});}
ws.onmessage = event => {
  const message=JSON.parse(event.data);
  if(message.id){const p=pending.get(message.id);pending.delete(message.id);if(message.error)p?.reject(message.error);else p?.resolve(message.result);}
  if(message.method==='Page.screencastFrame'){
    const {data,metadata,sessionId}=message.params;
    if(recording){const index=recording.frames.length; const file=`f${String(index).padStart(5,'0')}.jpg`;fs.writeFileSync(path.join(recording.dir,file),Buffer.from(data,'base64'));recording.frames.push({file,timestamp:metadata.timestamp});}
    send('Page.screencastFrameAck',{sessionId});
  }
};
const evaluate=async expression=>(await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})).result?.value;
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
const [name,url,seconds='0',setup='',start='']=process.argv.slice(2);
await send('Page.navigate',{url});await sleep(6500);
if(setup)console.log('setup',await evaluate(setup));
await evaluate(`(()=>{const s=document.createElement('style');s.textContent='.caption,.controls,.bar{display:none!important}';document.head.append(s);return document.title})()`);
await sleep(1500);
const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(root,'qa',name+'.png'),Buffer.from(shot.data,'base64'));
if(Number(seconds)>0){
 const dir=path.join(root,'source',name);fs.mkdirSync(dir,{recursive:true}); recording={dir,frames:[]};
 await send('Page.startScreencast',{format:'jpeg',quality:94,maxWidth:1920,maxHeight:1080,everyNthFrame:1});
 if(start)await evaluate(start);
 await sleep(Number(seconds)*1000);
 await send('Page.stopScreencast');await sleep(100);
 const frames=recording.frames;fs.writeFileSync(path.join(dir,'frames.json'),JSON.stringify(frames,null,2));
 const lines=['ffconcat version 1.0'];frames.forEach((f,i)=>{lines.push(`file '${f.file}'`,`duration ${Math.max(.001,(frames[i+1]?.timestamp??f.timestamp+1/30)-f.timestamp).toFixed(6)}`)});
 fs.writeFileSync(path.join(dir,'frames.ffconcat'),lines.join('\n')+'\n');console.log({name,frames:frames.length,duration:frames.at(-1).timestamp-frames[0].timestamp}); recording=null;
}
await send('Page.close');ws.close();
