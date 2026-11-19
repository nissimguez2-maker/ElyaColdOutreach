// Shared isolation rule for synthetic provider reads and Telegram fixture sends.
// A caller-supplied fixture mode must never mutate a real or mixed database.
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {relative,isAbsolute,sep} from 'node:path';
import {getRecord} from './store.mjs';

export function assertMonitoringFixtureIsolation(db,{bindingId='primary',campaignId=null,candidateId=null,email=null}={}){
 const fail=()=>{throw Error('MONITOR_FIXTURE_ISOLATION_REQUIRED');};
 const path=db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;
 if(path){const rel=relative(realpathSync(tmpdir()),realpathSync(path));if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))fail();}
 const binding=getRecord(db,'telegram_binding',bindingId),positive=value=>Number.isSafeInteger(value)&&value>0;
 if(binding?.testOnly!==true||binding.confirmed!==true||![binding.userId,binding.chatId,binding.botId].every(positive)||binding.userId!==binding.chatId||binding.chatType&&binding.chatType!=='private')fail();
 const rows=kind=>db.prepare('SELECT id,data_json FROM records WHERE kind=?').all(kind).map(row=>({id:row.id,data:JSON.parse(row.data_json)}));
 const candidates=rows('candidate'),campaigns=rows('campaign'),contacts=rows('contact');
 if(!candidates.length||!campaigns.length||!contacts.length||candidates.some(row=>row.data.synthetic!==true&&row.data.syntheticOnly!==true)||campaigns.some(row=>row.data.synthetic!==true&&row.data.syntheticOnly!==true&&row.data.purpose!=='synthetic_qa')||contacts.some(row=>!/@[^@]+\.(?:invalid|test|example)$/i.test(row.id)||!candidates.some(candidate=>candidate.id===row.data.candidateId)))fail();
 const matches=(candidate,email)=>candidates.some(row=>row.id===candidate)&&contacts.some(row=>row.id===email&&row.data.candidateId===candidate);
 if(campaignId!==null&&!campaigns.some(row=>row.id===campaignId))fail();
 if((candidateId!==null||email!==null)&&!matches(candidateId,email))fail();
 if(rows('provider_lead_mapping').some(row=>!campaigns.some(campaign=>campaign.id===row.data.campaignId)||!matches(row.data.candidateId,row.data.email)))fail();
}
