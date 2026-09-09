import {DatabaseSync} from 'node:sqlite';
import {deserialize} from 'node:v8';
import {brotliDecompressSync} from 'node:zlib';
import fs from 'node:fs';
import {toSocietyState} from '../../../three-body/src/game/eland/adapter';
const db=new DatabaseSync('/Users/wangyu.rye/Desktop/eland/three-body/data/eland.sqlite3',{readOnly:true});
const runId='candidate-bounded-reproduction-window-v2-s20260815-y20-r1';
const row=db.prepare('SELECT * FROM runs WHERE id=?').get(runId)!;
const chunk=db.prepare('SELECT data FROM chunks WHERE hash=?').get(row.state_hash)!;
const state=deserialize(brotliDecompressSync(Buffer.from(chunk.data as Uint8Array)));
const out='/Users/wangyu.rye/Desktop/eland/output/promo-v2/data';
fs.writeFileSync(`${out}/cold-ending-events.json`,JSON.stringify(state.lastStep,null,2));
for(const event of [...state.world.past,...state.lastStep]){if(event.action?.kind==='communicate'){event.action.kind='talk';event.action.speakerMeaning=event.action.content;}}
for(const intent of state.intents){if(intent.nextAction?.kind==='communicate'){intent.nextAction.kind='talk';intent.nextAction.speakerMeaning=intent.nextAction.content;}}
const society=toSocietyState(state);
const result={version:'eland-promo-recorded-run-state-v1',source:{runId,stateHash:row.state_hash,revision:row.revision,sourceUpdatedAt:row.updated_at,snapshotType:'recorded terminal state; no adjacent monthly state retained'},civilizationId:state.civilization.number,elapsedMonths:state.clock.elapsedMonths,civilizationEnd:state.civilization.outcome,society};
fs.writeFileSync(`${out}/cold-ending-frame.json`,JSON.stringify(result));
console.log(JSON.stringify({runId,month:result.elapsedMonths,climate:society.climate,weather:society.weather,people:society.agents.map(p=>({id:p.id,name:p.name,cell:p.cellId,z:p.z,state:p.state})),animals:society.animals.length,worldKeys:Object.keys(society.world)}));db.close();
