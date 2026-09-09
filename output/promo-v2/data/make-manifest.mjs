import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const dir=path.dirname(new URL(import.meta.url).pathname);
const source=JSON.parse(fs.readFileSync(path.join(dir,'save-mt1m7vkc-1014f920-summary.json')));
const definitions=[
 {id:'founding',label:'开局与第一间住所',months:[0,1,2,3],focus:'rei-ayanami'},
 {id:'childhood-house',label:'后羿建成住所；幼年的孙疏影随母亲觅食',months:[17,18,19],focus:'houyi'},
 {id:'shuying-house',label:'孙疏影建成住所',months:[395,396,397],focus:'born-16-cai-wenji-7'},
 {id:'era-change',label:'一次真实的短暂乱纪元；没有灾难终局',months:[425,426,427],focus:'born-16-cai-wenji-7'},
 {id:'bronze-conversation',label:'玩家建议铜锡合炼；人物解释自己的困难',months:[474,475,476,477,478,479],focus:'born-16-cai-wenji-7'},
 {id:'teaching-conversation',label:'玩家建议传授手艺；人物仍须先谋生',months:[523,524,525,526,527,528,529,530],focus:'born-16-cai-wenji-7'},
 {id:'kiln-attempts',label:'孙疏影回到工地继续尝试；这六个月尝试均失败',months:[530,531,532,533,534,535,536],focus:'born-16-cai-wenji-7'},
 {id:'worry',label:'后凌川称呼玩家为主，并担心乱纪元',months:[707,708,709,710],focus:'born-115-cai-wenji-10'},
 {id:'future',label:'后若水回应文明的未来，先民继续生活',months:[785,786,787,788,789,790,791],focus:'born-193-cai-wenji-12'},
];
const frames=new Map();
const sequences=definitions.map(seq=>({...seq,frames:seq.months.map(month=>{
 const file=`c16-m${month}-frame.json`;const bytes=fs.readFileSync(path.join(dir,file));const f=JSON.parse(bytes);const rawEvents=JSON.parse(fs.readFileSync(path.join(dir,`c16-m${month}-events.json`)));
 const movingAgents=f.society.agents.filter(a=>new Set(a.tickPath??[]).size>1).map(a=>a.id);
 const row={month,calendar:f.calendar,frameFile:file,eventsFile:`c16-m${month}-events.json`,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,movingAgents,actionEvents:rawEvents.filter(e=>e.kind==='action').length,epoch:f.society.epoch,climate:f.society.climate};frames.set(month,row);return row;
})}));
const manifest={version:'eland-promo-replay-v2',createdAt:new Date().toISOString(),source:{database:'/Users/wangyu.rye/Desktop/eland/three-body/data/eland.sqlite3',mode:'readOnly',manualSaveId:source.row.id,snapshotHash:source.row.snapshot_hash,runId:source.runId,civilizationId:16,branchId:source.activeBranchId,savedAt:source.row.updated_at},projection:{module:'three-body/src/game/eland/adapter.ts:toSocietyState',legacyFieldBridge:'In memory only: old action.kind communicate becomes talk; old action.content is copied unchanged to action.speakerMeaning. Raw event exports preserve original fields.',movement:'Recorded tickPath, lastPath, previousCellId and animal movementPath retained.'},dialogueFile:'dialogue-records.json',sequences};
fs.writeFileSync(path.join(dir,'replay-manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({sequences:sequences.length,uniqueFrames:frames.size,frameBytes:[...frames.values()].reduce((n,f)=>n+f.bytes,0),framesWithAgentMovement:[...frames.values()].filter(f=>f.movingAgents.length).length,closedSource:source.row.id}));
