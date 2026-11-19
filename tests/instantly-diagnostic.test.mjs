import test from 'node:test';import assert from 'node:assert/strict';
import {openStore,getRecord,putRecord,controls} from '../src/store.mjs';
import {createBudget,reserveOperation,beginOperation,recordOutcome,operation} from '../src/operations.mjs';
import * as api from '../src/diagnostic-exception.mjs';import * as policy from '../src/diagnostic-policy.mjs';
const fresh='M1G-instantly-read-v2';
function setup(){const db=openStore(':memory:');createBudget(db,'historical-pilot','3','0','0');reserveOperation(db,{id:api.HISTORICAL,kind:'VERIFY',budgetId:'historical-pilot',reservation:'0.15',authorizationRef:'fixture',payload:{synthetic:true}});beginOperation(db,api.HISTORICAL);recordOutcome(db,api.HISTORICAL,{status:'SUCCEEDED',actual:null,evidence:'Fixture unknown billing'});api.startDiagnostic(db,Date.now());api.closeDiagnostic(db,'INSTANTLY_SCHEMA_TYPE_MISMATCH');return db;}
test('fresh Instantly-only diagnostic preserves closed v1 and historical reservation',()=>{const db=setup(),old=JSON.stringify(getRecord(db,'diagnostic_exception',api.ID)),history=JSON.stringify(operation(db,api.HISTORICAL));api.startDiagnostic(db,Date.now(),fresh);const spec=policy.diagnosticSpec(fresh);assert.equal(spec.calls.length,1);assert.equal(spec.calls[0].provider,'instantly');api.setSchemas(db,[{provider:'instantly',schemaHash:'a'.repeat(64)}],fresh);api.beginDiagnostic(db,fresh);api.claimCall(db,spec.calls[0],fresh);api.saveReadResult(db,'instantly',{matchingResultEvidence:true,resourceStatus:'0'},fresh);api.closeDiagnostic(db,'MATCHING_READ_CONFIRMED',fresh);assert.equal(getRecord(db,'diagnostic_exception',fresh).status,'CLOSED');assert.equal(JSON.stringify(getRecord(db,'diagnostic_exception',api.ID)),old);assert.equal(JSON.stringify(operation(db,api.HISTORICAL)),history);assert.deepEqual([controls(db).stopped,controls(db).launchAuthorized],[true,false]);assert.throws(()=>api.startDiagnostic(db,Date.now(),fresh));assert.throws(()=>api.startDiagnostic(db,Date.now()));db.close();});
test('fresh scope rejects Apify, changed IDs, extra fields and duplicates',()=>{const db=setup();api.startDiagnostic(db,Date.now(),fresh);api.setSchemas(db,[{provider:'instantly',schemaHash:'a'.repeat(64)}],fresh);api.beginDiagnostic(db,fresh);const call=policy.diagnosticSpec(fresh).calls[0];for(const wrong of [api.CALLS[0],{...call,arguments:{id:'00000000-0000-0000-0000-000000000000'}},{...call,extra:true}])assert.throws(()=>api.claimCall(db,wrong,fresh));api.claimCall(db,call,fresh);assert.throws(()=>api.claimCall(db,call,fresh));api.closeDiagnostic(db,'FAILED',fresh);assert.throws(()=>api.claimCall(db,call,fresh));db.close();});
test('unknown tests and changed prior closed evidence fail closed',()=>{const db=setup();assert.throws(()=>api.startDiagnostic(db,Date.now(),'arbitrary'));api.startDiagnostic(db,Date.now(),fresh);db.prepare('UPDATE operations SET evidence=? WHERE id=?').run('changed old evidence',api.INTENT.id);assert.throws(()=>api.beginDiagnostic(db,fresh));api.closeDiagnostic(db,'FAILED',fresh);db.close();});
test('fresh claim requires prior CLOSED authorization and CANCELLED operation',()=>{for(const mode of ['absent','active','not-cancelled']){const db=setup();if(mode==='absent')db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('diagnostic_exception',api.ID);if(mode==='active')putRecord(db,'diagnostic_exception',api.ID,{...getRecord(db,'diagnostic_exception',api.ID),status:'ACTIVE'});if(mode==='not-cancelled')db.prepare('UPDATE operations SET status=? WHERE id=?').run('FAILED',api.INTENT.id);assert.throws(()=>api.startDiagnostic(db,Date.now(),fresh),/PRIOR_TEST_NOT_CLOSED/);assert.equal(getRecord(db,'diagnostic_exception',fresh),null);db.close();}});

const discoveryId='M1G-discovery-only-v3';
function setupDiscovery(){const db=setup();api.startDiagnostic(db,Date.now(),fresh);api.closeDiagnostic(db,'INSTANTLY_CONNECTOR_UNAVAILABLE_OR_AUTH_REQUIRED',fresh);return db;}
test('one-use discovery authority retains both closed tests, reservation and stop with a launch-relative 60-second bound',()=>{
 const db=setupDiscovery(),before=JSON.stringify({v1:getRecord(db,'diagnostic_exception',api.ID),v2:getRecord(db,'diagnostic_exception',fresh),history:operation(db,api.HISTORICAL),controls:controls(db)});
 const started=Date.now();api.startDiagnostic(db,started,discoveryId);const spec=policy.diagnosticSpec(discoveryId),s=getRecord(db,'diagnostic_exception',discoveryId);
 assert.deepEqual(spec.calls,[]);assert.equal(Date.parse(s.hardDeadlineAt)-started,60000);assert.equal(Date.parse(s.deadlineAt)-started,40000);
 assert.throws(()=>api.claimDiscovery(db,{...spec.discovery,server:'apify'},discoveryId));
 assert.deepEqual(api.claimDiscovery(db,spec.discovery,discoveryId),spec.discovery);assert.throws(()=>api.claimDiscovery(db,spec.discovery,discoveryId));
 assert.throws(()=>api.claimCall(db,api.CALLS[1],discoveryId));api.closeDiagnostic(db,'INSTANTLY_DISCOVERY_RUNTIME_STARTING',discoveryId);
 assert.equal(getRecord(db,'diagnostic_exception',discoveryId).status,'CLOSED');assert.equal(operation(db,spec.intent.id).status,'CANCELLED');
 assert.throws(()=>api.startDiagnostic(db,Date.now(),discoveryId));assert.equal(JSON.stringify({v1:getRecord(db,'diagnostic_exception',api.ID),v2:getRecord(db,'diagnostic_exception',fresh),history:operation(db,api.HISTORICAL),controls:controls(db)}),before);db.close();
});
test('discovery requires both prior tests closed and rejects changed protected state or expiry',()=>{
 for(const mode of ['v2-active','v2-changed','expired']){const db=setupDiscovery();
  if(mode==='v2-active'){putRecord(db,'diagnostic_exception',fresh,{...getRecord(db,'diagnostic_exception',fresh),status:'ACTIVE'});assert.throws(()=>api.startDiagnostic(db,Date.now(),discoveryId));}
  else{api.startDiagnostic(db,Date.now(),discoveryId);if(mode==='v2-changed')putRecord(db,'diagnostic_exception',fresh,{...getRecord(db,'diagnostic_exception',fresh),terminalReason:'changed'});else putRecord(db,'diagnostic_exception',discoveryId,{...getRecord(db,'diagnostic_exception',discoveryId),deadlineAt:new Date(0).toISOString()});assert.throws(()=>api.claimDiscovery(db,policy.diagnosticSpec(discoveryId).discovery,discoveryId));api.closeDiagnostic(db,'FAILED',discoveryId);}
  db.close();
 }
});
const readinessId='M1G-readiness-only-v4';
const functionalId='M1G-functional-read-v5';
function setupFunctional(){const db=setupReadiness();api.startDiagnostic(db,Date.now(),readinessId);api.closeDiagnostic(db,'DISCOVERY_READY',readinessId);return db;}
test('functional authorization binds one read, readiness deadline and prior evidence without consuming the production authorization',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const db=setupFunctional(),start=Date.now();
 const before=JSON.stringify([getRecord(db,'diagnostic_exception',readinessId),operation(db,api.HISTORICAL),controls(db)]);
 api.startDiagnostic(db,start,functionalId);const spec=policy.diagnosticSpec(functionalId),s=getRecord(db,'diagnostic_exception',functionalId);
 assert.equal(spec.requestCap,10);assert.equal(Date.parse(s.readinessDeadlineAt)-start,20000);assert.equal(Date.parse(s.deadlineAt)-start,40000);assert.equal(Date.parse(s.hardDeadlineAt)-start,60000);
 assert.deepEqual(spec.calls,[api.CALLS[1]]);
 assert.throws(()=>api.setSchemas(db,[{provider:'instantly',schemaHash:'a'.repeat(64)}],functionalId),/READINESS_NOT_CONFIRMED/);
 api.claimDiscovery(db,spec.discovery,functionalId);api.recordDiscoveryObservation(db,observed(1,'READY'),functionalId);
 api.setSchemas(db,[{provider:'instantly',schemaHash:'a'.repeat(64)}],functionalId);api.beginDiagnostic(db,functionalId);
 for(const wrong of [api.CALLS[0],{...spec.calls[0],arguments:{id:'wrong'}},{...spec.calls[0],extra:true}])assert.throws(()=>api.claimCall(db,wrong,functionalId));
 api.claimCall(db,spec.calls[0],functionalId);assert.throws(()=>api.claimCall(db,spec.calls[0],functionalId));
 api.saveReadResult(db,'instantly',{matchingResultEvidence:true,resourceStatus:'0'},functionalId);api.closeDiagnostic(db,'MATCHING_READ_CONFIRMED',functionalId);
 assert.equal(getRecord(db,'diagnostic_exception',functionalId).status,'CLOSED');assert.throws(()=>api.startDiagnostic(db,Date.now(),functionalId));
 assert.equal(JSON.stringify([getRecord(db,'diagnostic_exception',readinessId),operation(db,api.HISTORICAL),controls(db)]),before);db.close();
});
test('functional readiness cannot exceed ten requests or twenty seconds; v4 evidence is protected',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 for(const mode of ['cap','deadline','changed-v4']){const db=setupFunctional();api.startDiagnostic(db,Date.now(),functionalId);const spec=policy.diagnosticSpec(functionalId);
  if(mode==='cap'){for(let i=1;i<=10;i++){api.claimDiscovery(db,spec.discovery,functionalId);api.recordDiscoveryObservation(db,observed(i),functionalId);if(i<10)t.mock.timers.tick(2000);}}
  if(mode==='deadline')t.mock.timers.tick(20000);
  if(mode==='changed-v4')putRecord(db,'diagnostic_exception',readinessId,{...getRecord(db,'diagnostic_exception',readinessId),terminalReason:'changed'});
  assert.throws(()=>api.claimDiscovery(db,spec.discovery,functionalId));api.closeDiagnostic(db,'OFFLINE_STOP',functionalId);db.close();
 }
});
function setupReadiness(){const db=setupDiscovery();api.startDiagnostic(db,Date.now(),discoveryId);api.closeDiagnostic(db,'INSTANTLY_DISCOVERY_RUNTIME_STARTING',discoveryId);return db;}
const observed=(attempt,decision='WAIT')=>({event:'DISCOVERY_STATUS_OBSERVED',provider:'instantly',server:'codex_apps',tool:'instantly_ai.get_campaign',attempt,readinessDecision:decision,readinessReason:decision==='WAIT'?'DISCOVERY_RUNTIME_STARTING':null,runtimeStatus:{type:'string',value:decision==='WAIT'?'starting':'connected'}});
test('readiness authority counts each exact request durably, enforces spacing and permits only observed starting',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const db=setupReadiness();const before=JSON.stringify([getRecord(db,'diagnostic_exception',discoveryId),operation(db,api.HISTORICAL),controls(db)]);
 api.startDiagnostic(db,Date.now(),readinessId);const spec=policy.diagnosticSpec(readinessId);
 api.claimDiscovery(db,spec.discovery,readinessId);assert.throws(()=>api.claimDiscovery(db,spec.discovery,readinessId));
 api.recordDiscoveryObservation(db,observed(1),readinessId);assert.throws(()=>api.claimDiscovery(db,spec.discovery,readinessId));
 t.mock.timers.tick(2000);api.claimDiscovery(db,spec.discovery,readinessId);assert.throws(()=>api.recordDiscoveryObservation(db,observed(1),readinessId));
 api.recordDiscoveryObservation(db,observed(2,'READY'),readinessId);t.mock.timers.tick(2000);assert.throws(()=>api.claimDiscovery(db,spec.discovery,readinessId));
 assert.equal(getRecord(db,'diagnostic_exception',readinessId).discoveryRequestCount,2);
 api.closeDiagnostic(db,'DISCOVERY_READY',readinessId);assert.throws(()=>api.startDiagnostic(db,Date.now(),readinessId));
 assert.equal(JSON.stringify([getRecord(db,'diagnostic_exception',discoveryId),operation(db,api.HISTORICAL),controls(db)]),before);db.close();
});
test('readiness stops at twenty requests and cannot reopen or execute a business call',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const db=setupReadiness();api.startDiagnostic(db,Date.now(),readinessId);const spec=policy.diagnosticSpec(readinessId);
 for(let i=1;i<=20;i++){api.claimDiscovery(db,spec.discovery,readinessId);api.recordDiscoveryObservation(db,observed(i),readinessId);if(i<20)t.mock.timers.tick(2000);}
 assert.throws(()=>api.claimDiscovery(db,spec.discovery,readinessId));assert.throws(()=>api.claimCall(db,api.CALLS[1],readinessId));
 api.closeDiagnostic(db,'READINESS_REQUEST_CAP',readinessId);assert.equal(getRecord(db,'diagnostic_exception',readinessId).status,'CLOSED');assert.throws(()=>api.claimDiscovery(db,spec.discovery,readinessId));db.close();
});
test('readiness refuses changed prior evidence, missing v3 closure and expired authorization',()=>{
 for(const mode of ['active','changed','expired']){const db=setupReadiness();if(mode==='active'){putRecord(db,'diagnostic_exception',discoveryId,{...getRecord(db,'diagnostic_exception',discoveryId),status:'ACTIVE'});assert.throws(()=>api.startDiagnostic(db,Date.now(),readinessId));}
 else{api.startDiagnostic(db,Date.now(),readinessId);if(mode==='changed')putRecord(db,'diagnostic_exception',discoveryId,{...getRecord(db,'diagnostic_exception',discoveryId),terminalReason:'changed'});else putRecord(db,'diagnostic_exception',readinessId,{...getRecord(db,'diagnostic_exception',readinessId),deadlineAt:new Date(0).toISOString()});assert.throws(()=>api.claimDiscovery(db,policy.diagnosticSpec(readinessId).discovery,readinessId));api.closeDiagnostic(db,'FAILED',readinessId);}db.close();}
});
test('readiness rejects missing request time and repeated or terminal observations',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const db=setupReadiness();api.startDiagnostic(db,Date.now(),readinessId);const spec=policy.diagnosticSpec(readinessId);
 api.claimDiscovery(db,spec.discovery,readinessId);api.recordDiscoveryObservation(db,observed(1),readinessId);assert.throws(()=>api.recordDiscoveryObservation(db,observed(1),readinessId));
 putRecord(db,'diagnostic_exception',readinessId,{...getRecord(db,'diagnostic_exception',readinessId),discoveryAttemptedAt:'invalid'});t.mock.timers.tick(2000);assert.throws(()=>api.claimDiscovery(db,spec.discovery,readinessId));api.closeDiagnostic(db,'FAILED',readinessId);db.close();
});
