import {readFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {openStore,getRecord,controls} from './store.mjs';
import {canonical,digest} from './values.mjs';
import {armAcceptance,assertFreshAcceptance,verifyAcceptanceSources,closeAcceptance} from './acceptance-authority.mjs';
import {buildInactiveLeadCopyManifest,validateInactiveLeadCopyManifest} from './instantly-pilot-scope.mjs';
import {createInactiveSetupSession} from './instantly-pilot-session.mjs';
import {createPilotFileHandoff,savePilotEvidence} from './instantly-pilot-host.mjs';

export async function runLeadCopyHost({root,db,directory,preparation,approvalReference,authorizationId}){
 const manifest=buildInactiveLeadCopyManifest(readFileSync(join(root,'work/inactive-one-step-pilot-v1/proposal.json'),'utf8'),authorizationId);
 validateInactiveLeadCopyManifest(manifest);
 if(preparation.manifestHash!==digest(canonical(manifest)))throw Error('TESTED_MANIFEST_CHANGED');
 for(const source of preparation.sourceFingerprints)if(digest(readFileSync(join(root,source.path)))!==source.sha256)throw Error('TESTED_SOURCE_CHANGED');
 if(getRecord(db,'acceptance_authorization',manifest.id)||existsSync(directory))throw Error('ONE_USE_SCOPE_ALREADY_EXISTS');
 mkdirSync(directory,{recursive:true});
 const save=(name,value)=>savePilotEvidence(directory,name,value),invocationId=randomUUID();
 const before={controls:controls(db),tables:Object.fromEntries(['sources','batches','approvals','budgets','operations','controls'].map(t=>[t,digest(JSON.stringify(db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()))])),records:db.prepare('SELECT * FROM records ORDER BY kind,id').all()};
 save('protected-before.json',before);
 let grant,session,handoff;
 try{
  const at=Date.now();
  grant=armAcceptance(db,manifest,preparation.sourceFingerprints,at,{executionApproval:{type:'EXPLICIT_LIVE_EXECUTION_APPROVAL',manifestHash:digest(canonical(manifest)),reference:approvalReference,approvedAt:new Date(at).toISOString()}});
  assertFreshAcceptance(db,manifest);verifyAcceptanceSources(root,grant);
  save('binding.json',{invocationId,manifest,manifestHash:grant.manifestHash,boundAt:grant.boundAt,expiresAt:grant.expiresAt,sourceFingerprints:grant.sourceFingerprints});
  handoff=createPilotFileHandoff(directory);
  session=createInactiveSetupSession({db,manifest,root,invocationId});
  let result=await session.run(handoff.invoke);
  handoff.close();
  if(getRecord(db,'acceptance_authorization',manifest.id)?.status==='APPROVED'){
   result={...result,status:'BLOCKED',notLaunched:true,authorizationStatus:'CLOSED'};
   closeAcceptance(db,result);
  }
  save('result.json',result);
  save('calls.json',manifest.calls.map((_,i)=>getRecord(db,'inactive_setup_call',manifest.id+':'+i)));
  const changed=[];
  for(const [t,h]of Object.entries(before.tables))if(digest(JSON.stringify(db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()))!==h)changed.push(t);
  for(const row of before.records)if(JSON.stringify(db.prepare('SELECT * FROM records WHERE kind=? AND id=?').get(row.kind,row.id))!==JSON.stringify(row))changed.push(row.kind+':'+row.id);
  save('preservation.json',{changedProtectedRecords:changed,controls:controls(db),authorizationStatus:getRecord(db,'acceptance_authorization',manifest.id)?.status,localFileWaitClosed:true});
  return {result,changedProtectedRecords:changed};
 }catch(e){
  const reason=/^[A-Z][A-Z0-9_]+$/.test(e?.message??'')?e.message:'LOCAL_HOST_FAILED';
  if(session&&getRecord(db,'acceptance_authorization',manifest.id)?.status==='CLAIMED')session.finish(reason);
  else if(grant&&getRecord(db,'acceptance_authorization',manifest.id)?.status==='APPROVED')closeAcceptance(db,{id:manifest.id,status:'BLOCKED',reason,notLaunched:true});
  save('host-error.json',{reason,authorizationStatus:getRecord(db,'acceptance_authorization',manifest.id)?.status??'MISSING'});
  throw Error(reason);
 }finally{handoff?.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.slice(2).join(' ')!=='--execute-approved-once')throw Error('EXPLICIT_EXECUTION_ARGUMENT_REQUIRED');
 const root=fileURLToPath(new URL('../',import.meta.url));
 const preparation=JSON.parse(readFileSync(join(root,'work/inactive-lead-copy-v1/preparation.json'),'utf8'));
 const db=openStore(join(root,'data/elya.sqlite'));
 try{
  const outcome=await runLeadCopyHost({root,db,directory:join(root,'work/inactive-lead-copy-v1/live-once'),preparation,approvalReference:'Daniel Rosen consolidated mission: one fresh remaining lead-copy execution, three reads/one write,120 seconds; exact previously approved copy; no campaign write or activation'});
  console.log(JSON.stringify(outcome));process.exitCode=outcome.result.status==='PASS'&&outcome.changedProtectedRecords.length===0?0:2;
 }catch(e){console.log(JSON.stringify({reason:e.message}));process.exitCode=2;}
 finally{db.close();}
}
