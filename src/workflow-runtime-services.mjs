// Dormant production wiring. No credential access, process launch or networking
// occurs on import. Missing reviewed provider contracts remain explicit gates.
import {resolve} from 'node:path';
import {getRecord,controls} from './store.mjs';
import {createContainedHandoffTransport} from './handoff-app-server.mjs';
import {createProductionHandoffAdapter} from './handoff-production.mjs';
import {readProtected} from './windows-protected-storage.mjs';
export function productionWorkflowServices(db,task,{root,dbPath,clock}={}){
 const policy=getRecord(db,'settings','workflow-runtime');
 if(policy?.enabled!==true||policy.generalDispatchEnabled!==true||controls(db).stopped)throw Error('WORKFLOW_PRODUCTION_ENTRY_DISABLED');
 if(task.action==='COLLECT')throw Error('COLLECTION_CURRENT_TOOL_PRICING_CHARGE_CONTRACT_REQUIRED');
 if(task.action==='POLL_REPLIES')throw Error('REPLY_NONEMPTY_PAYLOAD_PAGINATION_AND_LINK_CONTRACT_REQUIRED');
 if(task.action==='HANDOFF'){
  const config=getRecord(db,'settings','handoff-runtime'),runtimeContracts=config&&getRecord(db,'handoff_runtime_contract',config.contractId);
  if(!config?.executable||!runtimeContracts)throw Error('HANDOFF_REVIEWED_CREATE_UPDATE_GET_CONTRACTS_REQUIRED');
  // Only the existing user's normal environment keys needed by the tested CLI.
  const environment=Object.fromEntries(['SystemRoot','WINDIR','COMSPEC','PATH','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','CODEX_HOME','TEMP','TMP'].filter(k=>typeof process.env[k]==='string').map(k=>[k,process.env[k]]));
  const transport=createContainedHandoffTransport({dbPath:resolve(dbPath),root:resolve(root),directory:resolve(root,'work/workflow-dispatch'),executable:config.executable,environment,runtimeContracts});
  return {handoffAdapter:createProductionHandoffAdapter(db,{transport,clock,timeoutMs:config.timeoutMs})};
 }
 if(['NOTIFY','DELIVER_REPORT'].includes(task.action))return {loadTelegramToken:()=>readProtected(resolve(root,'data/private/telegram-token.dpapi'),5000)};
 return {};
}
