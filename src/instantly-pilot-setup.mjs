// Pure proposal binding. No DB, transport, approval grant or release operation.
// General business handoff retains its separate three-step policy and gates.
import {canonical,digest} from './values.mjs';

export const INACTIVE_PILOT_PROPOSAL=Object.freeze({
 path:'work/inactive-one-step-pilot-v1/proposal.json',
 sha256:'fc2dc42618877c059b67b08aec215c8299efd081b1ed8c2a48fa4d591565265d',
});
function freeze(value){
 if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
 return value;
}
export function createInactivePilotSetup(rawProposal){
 if(typeof rawProposal!=='string'||digest(rawProposal)!==INACTIVE_PILOT_PROPOSAL.sha256)throw Error('INACTIVE_PILOT_PROPOSAL_PIN_MISMATCH');
 const p=JSON.parse(rawProposal);
 const bound={
  profile:p.profile,label:'PROPOSAL — NOT AUTHORIZED OR RELEASED',
  proposalSha256:INACTIVE_PILOT_PROPOSAL.sha256,
  campaignId:p.campaignArguments.id,campaignName:p.campaignName,
  leadId:p.leadArguments.id,recipient:p.recipient,sender:p.campaignArguments.email_list[0],
  marker:p.marker,copy:p.plainTextCopy,preconditions:p.preconditions,
  calls:[
   {server:'codex_apps',tool:'instantly_ai.update_campaign',arguments:p.campaignArguments},
   {server:'codex_apps',tool:'instantly_ai.update_lead',arguments:p.leadArguments},
  ],
  preserveUnrelatedVariables:true,executionAuthorized:false,activationAllowed:false,
  sendingWindowNotApproved:true,runtimeContractCompatibilityVerified:false,
 };
 const review=freeze({...bound,hash:digest(canonical(bound))});
 return Object.freeze({
  review,
  // Position is a proposal slot, not a consumed execution claim. This check
  // cannot replace current-state preflight, approval, journaling or readback.
  validateCall(call,position){
   if(!Number.isInteger(position)||position<0||position>=review.calls.length)throw Error('INACTIVE_PILOT_POSITION_INVALID');
   if(canonical(call)!==canonical(review.calls[position]))throw Error('INACTIVE_PILOT_CALL_MISMATCH');
   return review.calls[position];
  },
 });
}
