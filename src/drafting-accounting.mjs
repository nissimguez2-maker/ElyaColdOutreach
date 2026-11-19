// Explicit, separately confirmed schema preparation. Never invoked by openStore or a worker.
import {readFileSync} from 'node:fs';
import {canonical,digest,required} from './values.mjs';
import {controls,transaction,journal} from './store.mjs';

const source=readFileSync(new URL('./schema.sql',import.meta.url),'utf8');
const current=source.match(/CREATE TABLE IF NOT EXISTS operations \([\s\S]*?\n\);/)[0];
const prior=current.replace("'READ','DRAFT'","'READ'");
const normalize=sql=>sql.replace('IF NOT EXISTS ','').replace('CREATE TABLE "operations"','CREATE TABLE operations').replace(/;\s*$/,'').trim();
const plain=rows=>rows.map(row=>({...row}));
export function previewDraftingAccountingUpgrade(db){
 const c=controls(db);
 if(!c.stopped||c.launchAuthorized)throw Error('DRAFT_ACCOUNTING_STOP_REQUIRED');
 if(db.prepare("SELECT 1 FROM operations WHERE status='DISPATCHING'").get())throw Error('DRAFT_ACCOUNTING_ACTIVE_OPERATION');
 const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='operations'").get()?.sql;
 if(typeof sql!=='string'||![normalize(prior),normalize(current)].includes(normalize(sql)))throw Error('DRAFT_ACCOUNTING_UNSUPPORTED_SCHEMA');
 const indexes=plain(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='operations' AND sql IS NOT NULL ORDER BY name").all());
 const expected=source.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS operation_[^;]+;/g).map(s=>normalize(s)).sort();
 if(canonical(indexes.map(i=>normalize(i.sql)).sort())!==canonical(expected))throw Error('DRAFT_ACCOUNTING_UNSUPPORTED_INDEXES');
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='_operations_with_draft'").get())throw Error('DRAFT_ACCOUNTING_TEMP_TABLE_EXISTS');
 if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('DRAFT_ACCOUNTING_FOREIGN_KEY_ERROR');
 const rows=plain(db.prepare('SELECT * FROM operations ORDER BY id').all());
 const body={version:'draft-accounting-upgrade-v1',required:normalize(sql)===normalize(prior),operationCount:rows.length,
  operationHash:digest(canonical(rows)),schemaHash:digest(sql),indexes,controls:c,
  budgetHash:digest(canonical(plain(db.prepare('SELECT * FROM budgets ORDER BY id').all()))),
  effect:'Add DRAFT kind only; preserve every operation, reservation, outcome and control; no dispatch'};
 return {...body,hash:digest(canonical(body))};
}
export function applyDraftingAccountingUpgrade(db,{confirmedHash,actor}){
 required(confirmedHash);required(actor);
 return transaction(db,()=>{
  const p=previewDraftingAccountingUpgrade(db);
  if(p.hash!==confirmedHash)throw Error('DRAFT_ACCOUNTING_CONFIRMATION_MISMATCH');
  if(!p.required)return {status:'ALREADY_SUPPORTED',hash:p.hash};
  db.exec(current.replace('IF NOT EXISTS operations','_operations_with_draft'));
  db.exec('INSERT INTO _operations_with_draft SELECT * FROM operations; DROP TABLE operations; ALTER TABLE _operations_with_draft RENAME TO operations;');
  for(const i of p.indexes)db.exec(i.sql);
  const after=plain(db.prepare('SELECT * FROM operations ORDER BY id').all());
  if(digest(canonical(after))!==p.operationHash||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('DRAFT_ACCOUNTING_PRESERVATION_FAILED');
  journal(db,'DRAFT_ACCOUNTING_SCHEMA_ADDED','operations',{actor,confirmedHash});
  return {status:'APPLIED',preservedOperations:after.length,dispatchEnabled:false};
 });
}
