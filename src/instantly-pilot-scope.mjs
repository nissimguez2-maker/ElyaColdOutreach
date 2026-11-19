import {canonical,digest} from './values.mjs';
import {createInactivePilotSetup,INACTIVE_PILOT_PROPOSAL} from './instantly-pilot-setup.mjs';

export const INACTIVE_SETUP_ID='elya-inactive-one-step-pilot-v1';
export const INACTIVE_SETUP_SOURCES=Object.freeze([
 'src/values.mjs','src/store.mjs','src/acceptance-authority.mjs','src/acceptance-instantly.mjs',
 'src/instantly-pilot-setup.mjs','src/instantly-pilot-scope.mjs','src/instantly-pilot-session.mjs',
 INACTIVE_PILOT_PROPOSAL.path,'work/track-b-prerequisites-v1/inspection-result.json',
 'work/track-b-prerequisites-v1/continuation/raw-internal-lead.json',
]);
export function buildInactiveSetupManifest(rawProposal){
 const {review}=createInactivePilotSetup(rawProposal);
 const campaign={server:'codex_apps',tool:'instantly_ai.get_campaign',arguments:{id:review.campaignId}};
 const lead={server:'codex_apps',tool:'instantly_ai.get_lead',arguments:{id:review.leadId}};
 return {
  id:INACTIVE_SETUP_ID,version:1,route:'DIRECT_PLUGIN',proposalSha256:review.proposalSha256,bindingHash:review.hash,
  targets:{campaignId:review.campaignId,leadId:review.leadId,recipient:review.recipient,sender:review.sender},
  limits:{totalMs:60000,maxReads:4,maxWrites:2,retries:false,fallback:false},
  // Confirm the first write before permitting the second; no additional read.
  calls:structuredClone([campaign,lead,review.calls[0],campaign,review.calls[1],lead]),
  businessLaunchAuthorized:false,generalDispatchEnabled:false,monetaryReservationAllowed:false,
 };
}
export function validateInactiveSetupManifest(manifest){
 if(digest(canonical(manifest))!=='7b691143ff0dd96b13937c422f0a250fe7215e53fbff5957a979fd298d353443')throw Error('INACTIVE_SETUP_MANIFEST_MISMATCH');
 return manifest;
}

export const INACTIVE_LEAD_COPY_ID='elya-inactive-lead-copy-v1';
export const INACTIVE_LEAD_COPY_V2_ID='elya-inactive-lead-copy-v2';
export const isInactiveLeadCopyId=id=>id===INACTIVE_LEAD_COPY_ID||id===INACTIVE_LEAD_COPY_V2_ID;
export const INACTIVE_LEAD_COPY_BASELINES=Object.freeze({
 campaign:Object.freeze({path:'work/inactive-setup-authority-v1/live-once/response-3.json',sha256:'d8d4936c885306ed63c3764ed9b97071e7a3ae7934e464d23168f3d10e468600'}),
 lead:Object.freeze({path:'work/inactive-setup-authority-v1/live-once/response-1.json',sha256:'43b16eea1ca02b75bab2c8aeca0b694583f83ec9d11a06d2cc49969c6fac090b'}),
});
export const INACTIVE_LEAD_COPY_SOURCES=Object.freeze([
 ...INACTIVE_SETUP_SOURCES,'src/instantly-pilot-host.mjs','src/instantly-pilot-resume-cli.mjs',
 ...Object.values(INACTIVE_LEAD_COPY_BASELINES).map(v=>v.path),
 'work/inactive-setup-authority-v1/live-once/result.json',
 'work/inactive-setup-authority-v1/live-once/closeout.md',
 'work/inactive-setup-authority-v1/live-once/host-operation-inventory.json',
]);
export function buildInactiveLeadCopyManifest(rawProposal,id=INACTIVE_LEAD_COPY_ID){
 if(!isInactiveLeadCopyId(id))throw Error('INACTIVE_SETUP_MANIFEST_MISMATCH');
 const original=buildInactiveSetupManifest(rawProposal);
 return {...original,id,limits:{totalMs:120000,maxReads:3,maxWrites:1,retries:false,fallback:false},
  baselines:structuredClone(INACTIVE_LEAD_COPY_BASELINES),calls:structuredClone([original.calls[0],original.calls[1],original.calls[4],original.calls[5]])};
}
export function validateInactiveLeadCopyManifest(manifest){
 const pin=manifest?.id===INACTIVE_LEAD_COPY_ID?'3bfbdd88b817598007158da2971e4d1f97621a0f36b350e88d4341e397e919ea':manifest?.id===INACTIVE_LEAD_COPY_V2_ID?'05e22ac6afba4a89033d7b38d21485644c44f19e8f082233761da01b0f2d1664':null;
 if(!pin||digest(canonical(manifest))!==pin)throw Error('INACTIVE_SETUP_MANIFEST_MISMATCH');
 return manifest;
}
