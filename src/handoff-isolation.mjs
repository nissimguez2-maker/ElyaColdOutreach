// An opaque capability for an explicitly isolated offline transport. A boolean on
// a batch or caller-supplied object must never disable the synthetic export gate.
import {realpathSync} from 'node:fs';
import {dirname,relative,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {getRecord} from './store.mjs';

const capabilities=new WeakMap();
const inside=(path,root)=>{const r=relative(root,path);return r!==''&&!r.startsWith('..'+sep)&&r!=='..'&&!r.startsWith(sep)&&!r.includes(':');};
export function assertHandoffIsolation(db){
 const marker=getRecord(db,'settings','handoff-fixture-isolation');
 if(marker?.isolated!==true||typeof marker.fixtureId!=='string'||!marker.fixtureId.trim())throw Error('Handoff fixture isolation marker required');
 const path=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file;
 if(path){
  const actual=realpathSync(path),temp=realpathSync(tmpdir()),work=resolve(dirname(fileURLToPath(import.meta.url)),'../work/acceptance');
  const first=relative(temp,actual).split(sep)[0];
  if(!(inside(actual,temp)&&/^elya-(?:handoff|acceptance)-/.test(first))&&!(inside(actual,work)&&inside(actual,realpathSync(work))))throw Error('Handoff fixture isolation path required');
 }
 const rows=kind=>db.prepare('SELECT id,data_json FROM records WHERE kind=?').all(kind).map(r=>({id:r.id,data:JSON.parse(r.data_json)}));
 const candidates=rows('candidate'),campaigns=rows('campaign'),contacts=rows('contact');
 if(!candidates.length||!campaigns.length||!contacts.length||candidates.some(r=>r.data.synthetic!==true&&r.data.syntheticOnly!==true)||campaigns.some(r=>r.data.purpose!=='synthetic_qa')||contacts.some(r=>!/@[^@]+\.(?:invalid|test|example)$/i.test(r.id)||!candidates.some(c=>c.id===r.data.candidateId)))throw Error('Handoff fixture isolation requires synthetic-only records and reserved email domains');
 return marker;
}
export function createIsolatedHandoffAdapter(db,transport){
 assertHandoffIsolation(db);
 if(typeof transport?.execute!=='function')throw Error('Explicit isolated fixture transport required');
 const timeoutMs=transport.timeoutMs??5000;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('Bounded fixture transport timeout required');
 const adapter=Object.freeze({mode:'isolated-handoff-fixture'});capabilities.set(adapter,{db,execute:transport.execute.bind(transport),timeoutMs});return adapter;
}
export function permitsIsolatedHandoff(db,adapter){
 if(!adapter)return false;
 if(capabilities.get(adapter)?.db!==db)throw Error('Handoff fixture adapter isolation mismatch');
 assertHandoffIsolation(db);return true;
}
export function fixtureHandoffTransport(db,adapter){
 if(!permitsIsolatedHandoff(db,adapter))throw Error('Only an isolated handoff fixture adapter can execute');
 const {execute,timeoutMs}=capabilities.get(adapter);
 return async(call,remainingMs=timeoutMs)=>{
  let timer;const controller=new AbortController();
  try{return await Promise.race([Promise.resolve().then(()=>execute(call,{signal:controller.signal})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Handoff fixture transport timeout; outcome uncertain'));},Math.min(timeoutMs,Math.max(1,remainingMs)));})]);}
  finally{clearTimeout(timer);}
 };
}
