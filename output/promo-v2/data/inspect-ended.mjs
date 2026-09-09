import {DatabaseSync} from 'node:sqlite';
import {deserialize} from 'node:v8';
import {brotliDecompressSync} from 'node:zlib';
import fs from 'node:fs';
const db=new DatabaseSync('/Users/wangyu.rye/Desktop/eland/three-body/data/eland.sqlite3',{readOnly:true});
const chunk=hash=>{const r=db.prepare('SELECT codec,data FROM chunks WHERE hash=?').get(hash);return {...r,data:Buffer.from(r.data)};};
const ids=process.argv.slice(2).length?process.argv.slice(2):['terminal5-local-20260831-r1-s20260817-y1000','terminal5-local-20260831-r1-s185-y1000','terminal5-local-20260831-r1-s17-y1000'];
const readField=(hash,name)=>{const first=chunk(hash);if(first.codec!=='eland-run-state-root-v1')return deserialize(brotliDecompressSync(first.data))[name];const root=deserialize(first.data);const shell=chunk(root.shellHash);if(shell.codec==='eland-run-state-shell-manifest-v1'){const meta=deserialize(shell.data);const f=meta.fields.find(f=>f.name===name);if(f.kind==='value')return deserialize(brotliDecompressSync(chunk(f.hash).data));return f.segments.flatMap(s=>deserialize(brotliDecompressSync(chunk(s.hash).data)));}return deserialize(brotliDecompressSync(shell.data))[name];};
const results=[];
for(const id of ids){const row=db.prepare('SELECT * FROM runs WHERE id=?').get(id);const c=readField(row.state_hash,'civilization');const last=readField(row.state_hash,'lastStep');const result={row,civilization:c,lastEvents:last,checkpoints:db.prepare('SELECT revision,month,state_hash,created_at FROM run_checkpoints WHERE run_id=? ORDER BY month DESC LIMIT 3').all(id)};results.push(result);console.log(JSON.stringify({id,month:row.elapsed_months,status:c.status,epoch:c.epoch,climate:c.climate,outcome:c.outcome,lastEvents:last.filter(e=>e.kind==='environment'&&e.change==='death').map(e=>({id:e.id,result:e.result,change:e.change,cause:e.diff?.cause}))}));}
fs.writeFileSync(`/Users/wangyu.rye/Desktop/eland/output/promo-v2/data/${process.argv.slice(2).length?'early-ended':'ended'}-run-evidence.json`,JSON.stringify(results,null,2));db.close();
