import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import SocietyScene3D, {type SocietyCaptureApi} from '/src/components/SocietyScene3D';
import ThreeBodyCanvas, {type ThreeBodyCaptureApi} from '/src/components/ThreeBodyCanvas';
import AtmosphereTransition, {type AtmosphereCaptureApi} from '/src/components/AtmosphereTransition';
import {stellarFlux, DEFAULT_PRESET} from '/src/lib/threebody';
import {interpolatePath} from '/src/game/pixelworld';
import '/src/index.css';

const params=new URL(location.href).searchParams;
const shot=params.get('shot')||'walk';
const SHUYING='born-16-cai-wenji-7';
const RUOSHUI='born-193-cai-wenji-12';
type V=[number,number,number];
type Spec={months?:number[];file?:string;focus?:string;duration:number;kind?:string;distance?:number;height?:number;angle?:number;turn?:number;fov?:number;fixed?:V;window?:[number,number];first?:boolean;dialogue?:string;memory?:boolean};
const specs:Record<string,Spec>={
  walk:{months:[528],focus:SHUYING,duration:5,distance:3.1,height:1.3,angle:2.2,turn:-.35,window:[0,.4]},
  childhood:{months:[17],focus:'cai-wenji',duration:4,distance:4.2,height:2.0,angle:.35,turn:.15,window:[.05,.85]},
  craft:{months:[19],focus:'rei-ayanami',duration:3,distance:2.7,height:1.3,angle:1.0,turn:.45,window:[.05,.9]},
  house:{months:[395,396,397],focus:SHUYING,duration:6,distance:4.9,height:2.3,angle:1.25,turn:-.45},
  memory:{months:[397],focus:SHUYING,duration:6,distance:4.9,height:2.1,angle:.8,turn:.22,memory:true},
  handoff:{months:[528],focus:'born-115-cai-wenji-10',duration:3,distance:2.2,height:.75,angle:3.8,turn:.18,window:[.1,.95]},
  village:{months:[788,789],focus:RUOSHUI,duration:6,distance:13,height:10,angle:.7,turn:.25},
  homecoming:{months:[530],focus:SHUYING,duration:4,distance:3.8,height:1.5,angle:1.2,turn:-.2,window:[0,.5]},
  firstperson:{months:[787],focus:SHUYING,duration:4,distance:0,height:0,angle:0,first:true,window:[.15,.65]},
  teaching:{months:[527,528],focus:SHUYING,duration:12,distance:3.5,height:1.45,angle:1.65,turn:-.2,dialogue:'teaching'},
  future:{months:[786,787,788],focus:RUOSHUI,duration:9,distance:3.6,height:1.4,angle:1.0,turn:.24,dialogue:'future'},
  era:{months:[425,426,427],focus:SHUYING,duration:4,distance:8.5,height:2.0,angle:2.1,turn:.45},
  cold:{file:'cold-ending-frame.json',duration:4,distance:13,height:5.5,angle:.8,turn:.23},
  'cold-close':{file:'cold-ending-frame.json',focus:'zhugeliang',duration:3,distance:3.3,height:1.7,angle:1.15,turn:-.24},
  cosmos:{months:[0],duration:4,kind:'cosmos'},
  dive:{months:[0],duration:4,kind:'dive'},
  stars:{months:[426],duration:4,kind:'cosmos'},
  atmosphere:{months:[0],duration:2,kind:'atmosphere'},
  arrival:{months:[1],focus:'rei-ayanami',duration:4,distance:16,height:10,angle:.75,turn:-.1,window:[.05,.75]},
  final:{months:[788,789,790],focus:RUOSHUI,duration:7,distance:9,height:6.8,angle:.75,turn:.3},
};
const spec=specs[shot]; if(!spec)throw new Error('Unknown shot '+shot);
const files=spec.file?[spec.file]:spec.months!.map(m=>`c16-m${m}-frame.json`);
const frames=await Promise.all(files.map(f=>fetch('./data/'+f).then(r=>{if(!r.ok)throw new Error(f);return r.json()})));
let frame=frames[0],index=-1,api:SocietyCaptureApi|null=null,cosmos:ThreeBodyCaptureApi|null=null,atmosphere:AtmosphereCaptureApi|null=null;
let dialogueComponent:any=null;
if(spec.dialogue)dialogueComponent=(await import('./RecordedDialogue')).default;
if(spec.memory)dialogueComponent=(await import('./RecordedMemory')).default;
const root=createRoot(document.getElementById('root')!);
const center=(f:any,id?:string):V=>{const a=f.society.agents.find((v:any)=>v.id===id)||f.society.agents.find((v:any)=>v.state==='active')||f.society.agents[0];const c=a?.cellId??f.society.world.width*f.society.world.height/2;return [c%f.society.world.width-f.society.world.width/2+.5,(a?.z??5)*.3,Math.floor(c/f.society.world.width)-f.society.world.height/2+.5]};
function sky(f:any){const c=f.cosmosSnapshot;if(!c)return undefined;return {t:c.t,fluxRel:stellarFlux({state:Float64Array.from(c.state),masses:Float64Array.from(c.masses)})/c.fluxBase,bodies:c.state.slice(0,8)}}
let clock=0;
const sceneCapture={manual:true,pixelRatio:1,hideNameLabels:true,hideSpeech:true,onReady:(v:SocietyCaptureApi|null)=>{api=v}};
const spaceCapture={manual:true,pixelRatio:1,onReady:(v:ThreeBodyCaptureApi|null)=>{cosmos=v}};
const airCapture={manual:true,pixelRatio:1,onReady:(v:AtmosphereCaptureApi|null)=>{atmosphere=v}};
function display(time:number){
 if(spec.kind==='cosmos'||spec.kind==='dive'){
  root.render(<ThreeBodyCanvas running speed={shot==='stars'?.25:.09} trailLength={1500} showTwin={false} presetKey={DEFAULT_PRESET} resetToken={0} civilizationId={frame.civilizationId} restoreSnapshot={frame.cosmosSnapshot} capture={spaceCapture}/>);return;
 }
 if(spec.kind==='atmosphere'){
  root.render(<div style={{width:'100%',height:'100%',background:'#416e94'}}><AtmosphereTransition direction="dive" onComplete={()=>{}} onOpaque={()=>{}} capture={airCapture}/></div>);return;
 }
 const C=dialogueComponent;
 root.render(<><SocietyScene3D society={frame.society} era={frame.society.epoch||'stable'} speaker={null} sky={sky(frame)} monthPlaybackDurationMs={spec.duration*1000/frames.length/(spec.window?spec.window[1]-spec.window[0]:1)} cameraMode={spec.first?{kind:'embodiment',agentId:spec.focus!}:{kind:'overview'}} capture={sceneCapture}/>{C&&<C record={spec.dialogue} time={time}/>}</>);
}
flushSync(()=>display(0));
const wait=()=>new Promise(r=>setTimeout(r,0));
for(let i=0;i<300&&!api&&!cosmos&&!atmosphere;i++)await new Promise(r=>setTimeout(r,50));
if(!api&&!cosmos&&!atmosphere)throw new Error('Capture API not ready');

async function render(time:number){
 clock=time*1000;
 if(cosmos){
  if(spec.kind==='dive')cosmos.focusPlanet(true);
  cosmos.renderAt(clock);
  const p=cosmos.getPlanet(); const ease=(x:number)=>x*x*(3-2*x); const u=Math.min(1,time/spec.duration);
  if(spec.kind==='dive'){
   const dist=p.radius*(18*Math.pow(2.3/18,ease(u)));
   cosmos.setCamera({position:[p.position[0]+dist*.28,p.position[1]-dist*.18,dist],target:[...p.position],fov:42});
  }else{
   const c=cosmos.getSnapshot(),a=c.state;
   const starCenter:V=[(a[0]+a[2]+a[4])/3,(a[1]+a[3]+a[5])/3,0];
   const radius=Math.max(...[0,1,2].map(i=>Math.hypot(a[i*2]-starCenter[0],a[i*2+1]-starCenter[1])),.5);
   const dist=radius*2.9;
   cosmos.setCamera({position:[starCenter[0]+Math.sin(u*.15)*dist*.25,starCenter[1]-dist*.28,dist],target:starCenter,fov:45});
  }
  cosmos.renderAt(clock);
  return {kind:spec.kind,time,planet:p};
 }
 if(atmosphere){atmosphere.renderAt(clock);return {kind:'atmosphere',time}}
 const segment=spec.duration/frames.length;
 const next=Math.min(frames.length-1,Math.floor(time/segment));
 if(next!==index){index=next;frame=frames[index];flushSync(()=>display(time));await wait();api!.setPlaybackStart(index*segment*1000-(spec.window?.[0]??0)*segment*1000/(spec.window?spec.window[1]-spec.window[0]:1));}
 else if(spec.dialogue||spec.memory){flushSync(()=>display(time));}
 api!.renderAt(clock);
 let raw=(spec.fixed||api!.getAgentPosition(spec.focus||'')||center(frame,spec.focus)) as V;
 const u=Math.min(1,time/spec.duration),angle=(spec.angle??.8)+(spec.turn??.2)*u;
 let target:V=[raw[0],raw[1]+.32,raw[2]];
 let position:V;
 if(spec.first){
  const a=frame.society.agents.find((x:any)=>x.id===spec.focus);const path=a.tickPath;const frac=(spec.window?.[0]??0)+u*((spec.window?.[1]??1)-(spec.window?.[0]??0));
  // In embodiment the official figure is hidden. Derive the eye anchor from
  // the same recorded path interpolation instead of its unrendered mesh.
  const p=interpolatePath(path,frame.society.world.width,frac);
  raw=[p.x-frame.society.world.width/2+.5,a.z*.3,p.y-frame.society.world.height/2+.5];
  position=[raw[0],raw[1]+.49,raw[2]];
  const ahead=interpolatePath(path,frame.society.world.width,Math.min(.999,frac+.08));
  let dx=ahead.x-p.x,dz=ahead.y-p.y;if(Math.hypot(dx,dz)<.01){dx=0;dz=-1}const len=Math.hypot(dx,dz);target=[position[0]+dx/len*3,position[1]-.03,position[2]+dz/len*3];
 }else{
  const d=(spec.distance??5)*(1-.06*u),h=spec.height??2;
  position=[raw[0]+Math.sin(angle)*d,raw[1]+h,raw[2]+Math.cos(angle)*d];
  if(spec.dialogue||spec.memory){target=[raw[0]+Math.cos(angle)*.65,target[1],raw[2]-Math.sin(angle)*.65]}
 }
 api!.setCamera({position,target,fov:spec.fov??39});
 api!.renderAt(clock);
 return {kind:'society',time,month:frame.elapsedMonths,focus:spec.focus,position:raw,camera:position,target};
}
await render(0);
(window as any).__director={shot,spec,files,ready:true,render,async frame(time:number){const info=await render(time);const canvas=(api?.renderer||cosmos?.renderer||atmosphere?.renderer)?.domElement;return {info,jpeg:canvas?.toDataURL('image/jpeg',.98).split(',')[1]};},getInfo(){return {shot,spec,files,width:innerWidth,height:innerHeight}}};
document.title='READY · ELAND · '+shot;
