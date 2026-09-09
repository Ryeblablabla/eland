import { DatabaseSync } from 'node:sqlite';
import { deserialize } from 'node:v8';
import { writeFileSync } from 'node:fs';
import { decodeSessionSnapshotParts, createSessionTimelineChunkReference } from '../../../three-body/server/session-snapshot-codec';
import { inheritedSnapshot } from '../../../three-body/server/eland-session/timeline';
const db = new DatabaseSync('/Users/wangyu.rye/Desktop/eland/three-body/data/eland.sqlite3', {readOnly:true});
const chunk = (hash:string) => Buffer.from(db.prepare('SELECT data FROM chunks WHERE hash = ?').get(hash)!.data as Uint8Array);
const out='/Users/wangyu.rye/Desktop/eland/output/promo-v2/data';
const saveId='save-mt1m7vkc-1014f920';
const row=db.prepare('SELECT * FROM manual_saves WHERE id = ?').get(saveId)!;
const manifest=deserialize(chunk(row.snapshot_hash as string));
const save:any=decodeSessionSnapshotParts({compressedShell:chunk(manifest.shellHash),chunks:manifest.timelineChunkHashes.map(createSessionTimelineChunkReference)});
const s=save.session;const timeline=s.branches.get(s.activeBranchId);const resolve=(r:any)=>chunk(r.__elandSessionChunkV2);
const candidates:any[]=[];
for(const month of [397,528]){const state=inheritedSnapshot(s.branches,timeline,month,resolve)!;const p=state.people.find(p=>p.id==='born-16-cai-wenji-7')!;
 const records=p.memories;
 const excerpt={month,name:p.name,agentId:p.id,memoryCount:p.memories.length,memories:records.map(m=>({...m,sourceEvents:m.sourceEventIds.map(id=>state.world.past.find(e=>e.id===id)).filter(Boolean)})),mindMarkdown:p.mindMarkdown,cognitionKeys:Object.keys(p.cognition??{})};
 candidates.push(excerpt); console.log(JSON.stringify({month,name:p.name,memoryCount:p.memories.length,matched:records.map(m=>({id:m.id,summary:m.summary,at:m.createdAtMonth,sources:m.sourceEventIds})),cognitionKeys:excerpt.cognitionKeys,mindExcerpt:p.mindMarkdown?.slice(0,500)}));}
writeFileSync(`${out}/shuying-memory-candidates.json`,JSON.stringify(candidates,null,2));db.close();
