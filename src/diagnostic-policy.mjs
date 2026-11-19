import {canonical,digest} from './values.mjs';
import {getRecord,controls} from './store.mjs';
import {READINESS_INTERVAL_MS,READINESS_REQUEST_CAP} from './diagnostic-readiness.mjs';
export const ID='M1G-two-read-once-v1',HISTORICAL='historical:pC7valUiezwuOfB3b';
export const CALLS=Object.freeze([
 Object.freeze({provider:'apify',server:'apify',tool:'get-actor-run',arguments:Object.freeze({runId:'D2oXFE4Ns5FRBEQha',waitSecs:0})}),
 Object.freeze({provider:'instantly',server:'codex_apps',tool:'instantly_ai.get_campaign',arguments:Object.freeze({id:'339a5dbc-075c-4745-9a38-c11a26c5d920'})})
]);
export const INTENT=Object.freeze({id:'diagnostic:'+ID,kind:'READ',budgetId:ID,reservation:'0',authorizationRef:'diagnostic_exception:'+ID,payload:Object.freeze({testId:ID,calls:CALLS})});
export const INSTANTLY_ID='M1G-instantly-read-v2';
export const DISCOVERY_ID='M1G-discovery-only-v3';
export const READINESS_ID='M1G-readiness-only-v4';
export const FUNCTIONAL_ID='M1G-functional-read-v5';
const discovery=Object.freeze({provider:'instantly',server:'codex_apps',tool:'instantly_ai.get_campaign'});
const discoveryCalls=Object.freeze([]);
const discoveryIntent=Object.freeze({id:'diagnostic:'+DISCOVERY_ID,kind:'READ',budgetId:DISCOVERY_ID,reservation:'0',authorizationRef:'diagnostic_exception:'+DISCOVERY_ID,payload:Object.freeze({testId:DISCOVERY_ID,discoveryOnly:true,discovery})});
const readinessIntent=Object.freeze({id:'diagnostic:'+READINESS_ID,kind:'READ',budgetId:READINESS_ID,reservation:'0',authorizationRef:'diagnostic_exception:'+READINESS_ID,payload:Object.freeze({testId:READINESS_ID,discoveryOnly:true,discovery,requestCap:READINESS_REQUEST_CAP,intervalMs:READINESS_INTERVAL_MS,maximumMs:60000,dispatchMs:40000})});
const instantlyCalls=Object.freeze([CALLS[1]]);
const functionalIntent=Object.freeze({id:'diagnostic:'+FUNCTIONAL_ID,kind:'READ',budgetId:FUNCTIONAL_ID,reservation:'0',authorizationRef:'diagnostic_exception:'+FUNCTIONAL_ID,payload:Object.freeze({testId:FUNCTIONAL_ID,calls:instantlyCalls,discovery,requestCap:10,intervalMs:2000,readinessMs:20000,dispatchMs:40000,maximumMs:60000,toolRequestLimit:1,sameThreadRequired:true,retry:false,replay:false,fallback:false})});
const instantlyIntent=Object.freeze({id:'diagnostic:'+INSTANTLY_ID,kind:'READ',budgetId:INSTANTLY_ID,reservation:'0',authorizationRef:'diagnostic_exception:'+INSTANTLY_ID,payload:Object.freeze({testId:INSTANTLY_ID,calls:instantlyCalls})});
export function diagnosticSpec(testId=ID){
 if(testId===FUNCTIONAL_ID)return {id:FUNCTIONAL_ID,calls:instantlyCalls,intent:functionalIntent,discovery,functional:true,readiness:true,requestCap:10,intervalMs:2000,readinessMs:20000,maximumMs:60000,dispatchMs:40000};
 if(testId===ID)return {id:ID,calls:CALLS,intent:INTENT};
 if(testId===INSTANTLY_ID)return {id:INSTANTLY_ID,calls:instantlyCalls,intent:instantlyIntent};
 if(testId===DISCOVERY_ID)return {id:DISCOVERY_ID,calls:discoveryCalls,intent:discoveryIntent,discovery,maximumMs:60000,dispatchMs:40000};
 if(testId===READINESS_ID)return {id:READINESS_ID,calls:discoveryCalls,intent:readinessIntent,discovery,readiness:true,requestCap:READINESS_REQUEST_CAP,intervalMs:READINESS_INTERVAL_MS,maximumMs:60000,dispatchMs:40000};
 throw Error('UNKNOWN_DIAGNOSTIC_TEST');
}
export const historicalHash=db=>digest(JSON.stringify(db.prepare('SELECT * FROM operations WHERE id=?').get(HISTORICAL)));
export const priorClosedHash=db=>digest(JSON.stringify({exception:getRecord(db,'diagnostic_exception',ID),operation:db.prepare('SELECT * FROM operations WHERE id=?').get(INTENT.id)}));
export const priorV2Hash=db=>digest(JSON.stringify({exception:getRecord(db,'diagnostic_exception',INSTANTLY_ID),operation:db.prepare('SELECT * FROM operations WHERE id=?').get(instantlyIntent.id)}));
export const priorV3Hash=db=>digest(JSON.stringify({exception:getRecord(db,'diagnostic_exception',DISCOVERY_ID),operation:db.prepare('SELECT * FROM operations WHERE id=?').get(discoveryIntent.id)}));
export const priorV4Hash=db=>digest(JSON.stringify({exception:getRecord(db,'diagnostic_exception',READINESS_ID),operation:db.prepare('SELECT * FROM operations WHERE id=?').get(readinessIntent.id)}));
export function assertDiagnosticActive(db,testId=ID){
 const spec=diagnosticSpec(testId),s=getRecord(db,'diagnostic_exception',spec.id),c=controls(db);
 if(!s||s.status!=='ACTIVE'||s.intentHash!==digest(canonical(spec.intent))||!Number.isFinite(Date.parse(s.deadlineAt))||Date.now()>=Date.parse(s.deadlineAt)||!c.stopped||c.launchAuthorized)throw Error('DIAGNOSTIC_NOT_ACTIVE');
 if(s.historicalHash!==historicalHash(db))throw Error('HISTORICAL_STATE_CHANGED');
 if([INSTANTLY_ID,DISCOVERY_ID,READINESS_ID,FUNCTIONAL_ID].includes(testId)&&s.priorClosedHash!==priorClosedHash(db))throw Error('PRIOR_CLOSED_TEST_CHANGED');
 if([DISCOVERY_ID,READINESS_ID,FUNCTIONAL_ID].includes(testId)&&s.priorV2Hash!==priorV2Hash(db))throw Error('PRIOR_CLOSED_TEST_CHANGED');
 if([READINESS_ID,FUNCTIONAL_ID].includes(testId)&&s.priorV3Hash!==priorV3Hash(db))throw Error('PRIOR_CLOSED_TEST_CHANGED');
 if(testId===FUNCTIONAL_ID&&(s.priorV4Hash!==priorV4Hash(db)||s.readinessDeadlineAt!==new Date(Date.parse(s.startedAt)+spec.readinessMs).toISOString()))throw Error('PRIOR_OR_READINESS_STATE_CHANGED');
 return s;
}
export function permitsHistoricalDiagnostic(db,intent,blockers){
 try{
  const spec=diagnosticSpec(intent?.payload?.testId);
  if(canonical(intent)!==canonical(spec.intent))return false;
  assertDiagnosticActive(db,spec.id);
  return blockers.length===1&&blockers[0].id===HISTORICAL&&blockers[0].status==='RECONCILIATION'&&blockers[0].kind==='VERIFY'&&blockers[0].reservation_usd==='0.15'&&blockers[0].actual_usd===null;
 }catch{return false;}
}
