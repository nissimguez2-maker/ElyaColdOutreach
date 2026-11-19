// Local response holds only. No reply generation, transport, remote mutation or
// clearance operation. The operator writer requires an exact local preview.
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {relative,isAbsolute,sep} from 'node:path';
import {canonical,digest,required,timestamp} from './values.mjs';
import {getRecord,putRecord,transaction,journal} from './store.mjs';
import {validateNormalizedProviderEvent} from './monitoring.mjs';

const hash=value=>digest(canonical(value));
const types=['REPLY_RECEIVED','MANUAL_TAKEOVER','OPT_OUT','REFUSAL','NATIVE_SUPPRESSION_VERIFIED'];
const suppression=event=>['OPT_OUT','REFUSAL'].includes(event?.type);
const eventKey=eventId=>hash({eventId});
function exact(value,keys){
 canonical(value);
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw Error('MANUAL_RESPONSE_FIELDS_INVALID');
}
function email(value){if(typeof value!=='string'||value!==value.toLowerCase()||!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value))throw Error('MANUAL_RESPONSE_EMAIL_INVALID');}
function validateEvent(input,at){
 const extra=suppression(input)?['scope','scopeEvidenceRef']:input?.type==='NATIVE_SUPPRESSION_VERIFIED'?['suppressionEventId','nativeEvidenceId']:[];
 exact(input,['version','eventId','type','candidateId','email','occurredAt','actor','evidenceRef',...extra]);
 if(input.version!==1||!types.includes(input.type))throw Error('MANUAL_RESPONSE_TYPE_INVALID');
 for(const key of ['eventId','candidateId','actor','evidenceRef',...extra])required(input[key],key);
 email(input.email);
 if(timestamp(input.occurredAt)>timestamp(at))throw Error('MANUAL_RESPONSE_FUTURE_EVENT');
 if(suppression(input)&&!['MAILBOX','BUSINESS','UNRESOLVED'].includes(input.scope))throw Error('MANUAL_RESPONSE_SCOPE_INVALID');
}
function matchesIdentity(db,candidateId,address){return !!getRecord(db,'candidate',candidateId)&&getRecord(db,'contact',address)?.candidateId===candidateId;}
function assertFixture(db){
 const fail=()=>{throw Error('MANUAL_RESPONSE_FIXTURE_ISOLATION_REQUIRED');};
 const marker=getRecord(db,'settings','manual-response-fixture-isolation');
 if(marker?.isolated!==true||typeof marker.fixtureId!=='string'||!marker.fixtureId.trim())fail();
 const path=db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;
 if(path){
  const rel=relative(realpathSync(tmpdir()),realpathSync(path));
  if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)||!/^elya-manual-response-/.test(rel.split(sep)[0]))fail();
 }
 const candidates=db.prepare("SELECT id,data_json FROM records WHERE kind='candidate'").all(),contacts=db.prepare("SELECT id,data_json FROM records WHERE kind='contact'").all();
 if(!candidates.length||!contacts.length||candidates.some(row=>{const c=JSON.parse(row.data_json);return c.synthetic!==true&&c.syntheticOnly!==true;})||contacts.some(row=>!/@[^@]+\.(?:invalid|test|example)$/.test(row.id)||!candidates.some(c=>c.id===JSON.parse(row.data_json).candidateId)))fail();
}
function nativeEvidence(db,event,request,at){
 if(!request||!suppression(request.event)||request.hash!==hash(request.event))throw Error('MANUAL_NATIVE_EVIDENCE_REQUEST_REQUIRED');
 const target=request.event;
 if(target.scope==='UNRESOLVED')throw Error('MANUAL_SUPPRESSION_SCOPE_UNRESOLVED');
 if(event.candidateId!==target.candidateId||event.email!==target.email||timestamp(event.occurredAt)<timestamp(target.occurredAt))throw Error('MANUAL_NATIVE_EVIDENCE_REQUEST_MISMATCH');
 const row=db.prepare("SELECT data_json,basis FROM records WHERE kind='native_suppression_readback' AND id=?").get(event.nativeEvidenceId);
 if(!row||row.basis!=='provider_result')throw Error('MANUAL_NATIVE_EVIDENCE_REQUIRED');
 const saved=JSON.parse(row.data_json);
 exact(saved,['version','provider','scope','email','candidateId','status','observedAt','sourceRef','sourceSha256','hash']);
 const {hash:savedHash,...evidence}=saved;
 if(savedHash!==hash(evidence)||saved.version!==1||saved.provider!=='instantly'||saved.status!=='SUPPRESSED'||saved.scope!==target.scope||saved.email!==target.email||saved.candidateId!==target.candidateId||!/^[a-f0-9]{64}$/.test(saved.sourceSha256))throw Error('MANUAL_NATIVE_EVIDENCE_INVALID');
 required(saved.sourceRef);
 if([target.evidenceRef,target.scopeEvidenceRef,event.evidenceRef].includes(saved.sourceRef)||timestamp(saved.observedAt)<timestamp(target.occurredAt)||timestamp(saved.observedAt)>timestamp(event.occurredAt)||timestamp(event.occurredAt)>timestamp(at))throw Error('MANUAL_NATIVE_EVIDENCE_NOT_INDEPENDENT_OR_TIMELY');
 return saved;
}

function appendEvent(db,input,at,{fixtureOnly,operatorEntry=null}){
  if(!matchesIdentity(db,input.candidateId,input.email))throw Error('MANUAL_RESPONSE_IDENTITY_UNRESOLVED');
  const id=eventKey(input.eventId),old=getRecord(db,'manual_response_event',id),eventHash=hash(input);
  if(old){if(old.hash!==eventHash||canonical(old.event)!==canonical(input))throw Error('MANUAL_RESPONSE_EVENT_IDENTITY_CONFLICT');return {...old,duplicate:true};}
  let verification=null;
  if(input.type==='NATIVE_SUPPRESSION_VERIFIED'){
   const request=getRecord(db,'manual_response_event',eventKey(input.suppressionEventId)),evidence=nativeEvidence(db,input,request,at);
   verification={requestHash:request.hash,nativeEvidenceHash:evidence.hash};
  }
  const record={id,event:structuredClone(input),hash:eventHash,recordedAt:at,verification,...(operatorEntry?{operatorEntry}:{})};
  putRecord(db,'manual_response_event',id,record,'user_reported');
  journal(db,'MANUAL_RESPONSE_RECORDED',id,{type:input.type,eventHash,evidenceRef:input.evidenceRef,fixtureOnly,actor:input.actor,provenanceBasis:'user_reported',occurredAt:input.occurredAt,recordedAt:at,...(operatorEntry?{previewHash:operatorEntry.previewHash}:{})});
  return {...record,duplicate:false};
}

/** Retained fixture-only API. Operator attribution is not authentication. */
export function recordManualResponseEvent(db,input,at){
 validateEvent(input,at);
 const apply=()=>{assertFixture(db);return appendEvent(db,input,at,{fixtureOnly:true});};
 return db.isTransaction?apply():transaction(db,apply);
}

function databasePath(db){
 const path=db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;
 if(!path)throw Error('MANUAL_RESPONSE_EXISTING_FILE_DATABASE_REQUIRED');
 if(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value!=='1')throw Error('MANUAL_RESPONSE_SCHEMA_UNSUPPORTED');
 return realpathSync(path);
}
function operatorTarget(db,input,at){
 validateEvent(input,at);
 if(!matchesIdentity(db,input.candidateId,input.email))throw Error('MANUAL_RESPONSE_IDENTITY_UNRESOLVED');
 const contacts=db.prepare("SELECT id,data_json FROM records WHERE kind='contact' AND (json_extract(data_json,'$.candidateId')=? OR lower(id)=? OR lower(json_extract(data_json,'$.email'))=?) ORDER BY id").all(input.candidateId,input.email,input.email).map(row=>({key:row.id,data:JSON.parse(row.data_json)}));
 const aliases=contacts.filter(c=>c.key.toLowerCase()===input.email||c.data.email?.toLowerCase()===input.email);
 if(aliases.length!==1||aliases[0].key!==input.email||aliases[0].data.candidateId!==input.candidateId||aliases[0].data.email!==undefined&&aliases[0].data.email!==input.email)throw Error('MANUAL_RESPONSE_IDENTITY_AMBIGUOUS');
 const old=getRecord(db,'manual_response_event',eventKey(input.eventId));
 if(old&&(old.hash!==hash(input)||canonical(old.event)!==canonical(input)))throw Error('MANUAL_RESPONSE_EVENT_IDENTITY_CONFLICT');
 let evidence=null,scope=suppression(input)?input.scope:'MAILBOX';
 if(input.type==='NATIVE_SUPPRESSION_VERIFIED'){
  const request=getRecord(db,'manual_response_event',eventKey(input.suppressionEventId));
  if(request){validateEvent(request.event,at);if(request.id!==eventKey(request.event.eventId)||request.event.eventId!==input.suppressionEventId||!matchesIdentity(db,request.event.candidateId,request.event.email)||timestamp(request.recordedAt)<timestamp(request.event.occurredAt)||timestamp(request.recordedAt)>timestamp(at))throw Error('MANUAL_NATIVE_EVIDENCE_REQUEST_INVALID');}
  evidence=nativeEvidence(db,input,request,at);scope=request.event.scope;
 }
 const affectedContacts=scope==='MAILBOX'?[input.email]:contacts.filter(c=>c.data.candidateId===input.candidateId).map(c=>{email(c.key);if(c.data.email!==undefined&&c.data.email!==c.key)throw Error('MANUAL_RESPONSE_IDENTITY_AMBIGUOUS');return c.key;});
 return {scope,affectedContacts,evidence,old};
}
function relevantState(db,input){
 // Bind identity, provenance and all response/native evidence that can affect
 // this mailbox or business; unrelated drafting and budget activity is excluded.
 return db.prepare(`SELECT * FROM records WHERE
  (kind='candidate' AND id=?) OR
  (kind='contact' AND (json_extract(data_json,'$.candidateId')=? OR lower(id)=? OR lower(json_extract(data_json,'$.email'))=?)) OR
  (kind IN ('manual_response_event','provider_event') AND (json_extract(data_json,'$.event.email')=? OR json_extract(data_json,'$.event.candidateId')=? OR json_extract(data_json,'$.candidateId')=? OR (kind='manual_response_event' AND id IN (?,?)))) OR
  (kind='native_suppression_readback' AND (json_extract(data_json,'$.email')=? OR json_extract(data_json,'$.candidateId')=? OR id=?))
  ORDER BY kind,id`).all(input.candidateId,input.candidateId,input.email,input.email,input.email,input.candidateId,input.candidateId,eventKey(input.eventId),eventKey(input.suppressionEventId??''),input.email,input.candidateId,input.nativeEvidenceId??'').map(row=>({...row}));
}
function buildResponsePreview(db,input,at){
 const database=databasePath(db),target=operatorTarget(db,input,at);
 const preview={schemaVersion:'manual-response-preview-v1',status:'PREVIEW_ONLY_NOT_RECORDED',databasePath:database,previewedAt:at,event:structuredClone(input),eventHash:hash(input),provenanceBasis:'user_reported',scope:target.scope,affectedContacts:target.affectedContacts,currentGates:target.affectedContacts.map(address=>({email:address,...evaluateManualContactGate(db,{email:address,candidateId:input.candidateId,at})})),nativeEvidence:target.evidence,stateHash:hash(relevantState(db,input)),effects:{appendLocalEvent:!target.old,clearHolds:false,remoteActions:0,releaseAuthorized:false,autonomousRepliesEnabled:false}};
 return {...preview,hash:hash(preview)};
}

/** SELECT-only snapshot; the hash binds local intent/state, not authority. */
export function previewManualResponseEvent(db,input,at){
 if(db.isTransaction)return buildResponsePreview(db,input,at);
 db.exec('BEGIN');
 try{const preview=buildResponsePreview(db,input,at);db.exec('COMMIT');return preview;}
 catch(error){db.exec('ROLLBACK');throw error;}
}

/** The caller explicitly supplies the reviewed preview and confirmation hash.
 * Own the write transaction so no caller can skip the current-state recheck. */
export function recordPreviewedManualResponseEvent(db,input,preview,{confirmedPreviewHash,at}){
 exact(preview,['schemaVersion','status','databasePath','previewedAt','event','eventHash','provenanceBasis','scope','affectedContacts','currentGates','nativeEvidence','stateHash','effects','hash']);
 const {hash:previewHash,...body}=preview;
 if(preview.schemaVersion!=='manual-response-preview-v1'||preview.status!=='PREVIEW_ONLY_NOT_RECORDED'||!(/^[a-f0-9]{64}$/.test(confirmedPreviewHash))||confirmedPreviewHash!==previewHash||hash(body)!==previewHash||canonical(preview.event)!==canonical(input)||preview.eventHash!==hash(input))throw Error('MANUAL_RESPONSE_PREVIEW_BINDING_INVALID');
 if(timestamp(preview.previewedAt)>timestamp(at))throw Error('MANUAL_RESPONSE_PREVIEW_FUTURE');
 if(db.isTransaction)throw Error('MANUAL_RESPONSE_OWNS_WRITE_TRANSACTION');
 return transaction(db,()=>{
  if(databasePath(db)!==preview.databasePath)throw Error('MANUAL_RESPONSE_PREVIEW_DATABASE_MISMATCH');
  const target=operatorTarget(db,input,at);
  // Identical retries are harmless even if a concurrent first append changed
  // the snapshot. They still recheck identity and any required native evidence.
  if(!target.old){
   if(hash(relevantState(db,input))!==preview.stateHash)throw Error('MANUAL_RESPONSE_PREVIEW_STALE');
   if(buildResponsePreview(db,input,preview.previewedAt).hash!==previewHash)throw Error('MANUAL_RESPONSE_PREVIEW_BINDING_INVALID');
  }
  const record=appendEvent(db,input,at,{fixtureOnly:false,operatorEntry:{previewHash,stateHash:preview.stateHash,databasePath:preview.databasePath,previewedAt:preview.previewedAt}});
  return {status:record.duplicate?'ALREADY_RECORDED':'RECORDED_LOCAL_HOLD',event:record,gate:evaluateManualContactGate(db,{email:input.email,candidateId:input.candidateId,at}),remoteActions:0,releaseAuthorized:false,autonomousRepliesEnabled:false};
 });
}

/** SELECT-only supplementary gate. `allowed` means no observed manual-response
 * hold; it does not establish recipient eligibility, monitoring coverage or send
 * authority. Known holds never expire or clear through this module. */
export function evaluateManualContactGate(db,{email:address,candidateId,at}){
 email(address);required(candidateId);timestamp(at);
 const reasons=[],requests=[];let replyReceived=false,manualTakeover=false,unresolved=false;
 if(!matchesIdentity(db,candidateId,address))reasons.push('MANUAL_CONTACT_IDENTITY_UNRESOLVED');
 const related=(kind,path)=>db.prepare(`SELECT id,data_json FROM records WHERE kind=? AND (json_extract(data_json,'${path}.email')=? OR json_extract(data_json,'${path}.candidateId')=? OR json_extract(data_json,'$.candidateId')=?)`).all(kind,address,candidateId,candidateId).map(row=>({key:row.id,...JSON.parse(row.data_json)}));
 for(const record of related('provider_event','$.event')){
  if(record.event?.type!=='REPLIED')continue;
  try{validateNormalizedProviderEvent(record.event,at);if(!matchesIdentity(db,record.candidateId,record.event.email))throw Error('identity');}
  catch{reasons.push('MANUAL_PROVIDER_EVENT_IDENTITY_UNRESOLVED');unresolved=true;continue;}
  if(record.event.email===address){replyReceived=true;reasons.push('MANUAL_REPLY_RECEIVED');}
 }
 const records=related('manual_response_event','$.event'),valid=[];
 for(const record of records){
  try{
   validateEvent(record.event,at);
   if(record.key!==eventKey(record.event.eventId)||record.hash!==hash(record.event)||!matchesIdentity(db,record.event.candidateId,record.event.email)||timestamp(record.recordedAt)<timestamp(record.event.occurredAt)||timestamp(record.recordedAt)>timestamp(at))throw Error('identity');
   valid.push(record);
  }catch{reasons.push('MANUAL_RESPONSE_RECORD_INVALID');unresolved=true;}
 }
 const verified=new Set();
 for(const check of valid.filter(r=>r.event.type==='NATIVE_SUPPRESSION_VERIFIED')){
  try{
   const request=valid.find(r=>r.event.eventId===check.event.suppressionEventId),evidence=nativeEvidence(db,check.event,request,at);
   if(check.verification?.requestHash!==request.hash||check.verification?.nativeEvidenceHash!==evidence.hash)throw Error('binding');
   verified.add(check.key);
  }catch{reasons.push('MANUAL_NATIVE_SUPPRESSION_EVIDENCE_INVALID');unresolved=true;}
 }
 for(const record of valid){
  const e=record.event,applies=e.email===address||suppression(e)&&e.candidateId===candidateId&&e.scope!=='MAILBOX';
  if(!applies)continue;
  if(e.type==='REPLY_RECEIVED'){replyReceived=true;reasons.push('MANUAL_REPLY_RECEIVED');}
  if(e.type==='MANUAL_TAKEOVER'){manualTakeover=true;reasons.push('MANUAL_TAKEOVER_ACTIVE');}
  if(!suppression(e))continue;
  reasons.push(e.type==='OPT_OUT'?'MANUAL_OPT_OUT':'MANUAL_REFUSAL');
  let nativeStatus=e.scope==='UNRESOLVED'?'UNRESOLVED':'PENDING';
  if(e.scope==='UNRESOLVED')reasons.push('MANUAL_SUPPRESSION_SCOPE_UNRESOLVED');
  const checks=valid.filter(r=>r.event.type==='NATIVE_SUPPRESSION_VERIFIED'&&r.event.suppressionEventId===e.eventId);
  for(const check of checks){
   if(!verified.has(check.key))nativeStatus='UNRESOLVED';
   else if(nativeStatus!=='UNRESOLVED')nativeStatus='VERIFIED_FROM_SAVED_EVIDENCE';
  }
  if(nativeStatus==='PENDING')reasons.push('MANUAL_NATIVE_SUPPRESSION_PENDING');
  requests.push({eventId:e.eventId,type:e.type,scope:e.scope,candidateId:e.candidateId,email:e.email,occurredAt:e.occurredAt,evidenceRef:e.evidenceRef,scopeEvidenceRef:e.scopeEvidenceRef,nativeStatus});
 }
 const nativeSuppressionStatus=unresolved||requests.some(r=>r.nativeStatus==='UNRESOLVED')?'UNRESOLVED':requests.some(r=>r.nativeStatus==='PENDING')?'PENDING':requests.length?'VERIFIED_FROM_SAVED_EVIDENCE':'NOT_REQUESTED';
 return {allowed:reasons.length===0,reasons:[...new Set(reasons)],replyReceived,manualTakeover,suppressionRequests:requests,nativeSuppressionStatus,autonomousRepliesEnabled:false};
}
