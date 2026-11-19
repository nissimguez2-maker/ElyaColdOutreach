// Explicit opt-in only. The legacy mode keeps its historical serialized shape.
import {timestamp} from './values.mjs';
export const FIRST_TOUCH_CONTRACT='first-touch-only-v1';
export const LEGACY_WRITING_CONTRACT='offline-writing-v1';
export function writingMode(spec){
 const mode=spec?.contractVersion===undefined?LEGACY_WRITING_CONTRACT:spec.contractVersion;
 if(mode!==FIRST_TOUCH_CONTRACT&&mode!==LEGACY_WRITING_CONTRACT)throw Error('WRITING_CONTRACT_VERSION');
 return mode;
}
export function messageStepsForMode(mode){
 return writingMode({contractVersion:mode})===FIRST_TOUCH_CONTRACT?[1]:[1,2,3];
}
export function assertSequenceForMode(sequence,mode){
 if(writingMode({contractVersion:mode})===FIRST_TOUCH_CONTRACT){
  if(!sequence||Object.keys(sequence).sort().join(',')!=='endpoint,endpointApproved,steps'||sequence.steps!==1||sequence.endpoint!=='END_AFTER_FIRST_TOUCH'||typeof sequence.endpointApproved!=='boolean')throw Error('WRITING_SEQUENCE_REQUIRED');
 }else if(sequence?.steps!==3)throw Error('WRITING_SEQUENCE_REQUIRED');
}
export function sequenceReleaseReady(sequence,mode){
 try{assertSequenceForMode(sequence,mode);return sequence.endpointApproved===true&&(mode===FIRST_TOUCH_CONTRACT||sequence.cadenceApproved===true);}catch{return false;}
}
export function firstTouchExpiryPolicyConfigured(policy){
 const p=policy?.approvalExpiry;
 try{return p?.approved===true&&p.approvedBy===policy.approver&&typeof p.revision==='string'&&!!p.revision.trim()&&Number.isFinite(timestamp(p.approvedAt))&&p.maxCalendarDays===7&&p.timeZone==='America/New_York'&&!Object.hasOwn(p,'maxAgeMs');}catch{return false;}
}
const ny=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function localTime(ms){
 const p=Object.fromEntries(ny.formatToParts(ms).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
 return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second,new Date(ms).getUTCMilliseconds());
}
export function firstTouchApprovalDeadline(issuedAt){
 const start=timestamp(issuedAt),wall=localTime(start)+7*86400000;
 // Derive offsets from the installed timezone database, not a fixed UTC duration.
 const offsets=new Set([-1,0,1].map(day=>{const t=wall+day*86400000;return localTime(t)-t;}));
 const candidates=[...offsets].map(offset=>wall-offset),matching=candidates.filter(ms=>localTime(ms)===wall);
 // At an overlapping clock time choose the earlier instant. If that wall time
 // does not exist in a spring gap, expire conservatively before the gap.
 const end=matching.length?Math.min(...matching):Math.min(...candidates);
 if(!Number.isFinite(end)||end<=start)throw Error('WRITING_APPROVAL_EXPIRY_POLICY_REQUIRED');
 return new Date(end).toISOString();
}
