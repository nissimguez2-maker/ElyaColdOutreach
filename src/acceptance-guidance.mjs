import {WRITING_BUTTONS} from './telegram-writing-render.mjs';

// Describe the actual delivered button page; summary pages are not action targets.
export function acceptanceTarget(page,{version,messageId}){
 if(!page?.reply_markup?.inline_keyboard?.some(row=>row.length)||typeof page.text!=='string')throw Error('ACCEPTANCE_BUTTON_PAGE_REQUIRED');
 const step=/^## Step ([1-3])$/m.exec(page.text)?.[1];
 return {title:page.text.split('\n').find(line=>line.trim()).trim(),version,messageId,location:step?`Step ${step} (button-bearing message)`:'Review (button-bearing message)'};
}

export function nextAcceptanceAction(steps,scenarios,targets,budget={}){
 const step=steps.find(item=>scenarios[item.key]?.status!=='PASS');
 if(!step)return null;
 const target=targets[step.target];if(!target||!Number.isSafeInteger(target.messageId)||target.messageId<1)return null;
 return {event:'OPERATOR_NEXT_ACTION',scenario:step.key,...target,action:step.action,buttonLabel:WRITING_BUTTONS[step.action],expectedResult:step.expectedResult,...budget};
}

const outcomes={
 APPROVED:'Content approval recorded for this version only. Contact holds and sending restrictions remain unchanged.',
 STALE_REVIEW:'Stale review rejected. No new content decision recorded; this old button cannot approve the current version.',
 REVISION_REQUESTED:'Changes requested. This content version remains unapproved.',
 REJECTED:'Content rejected. Nothing has been released or sent.',
 ACTION_OUTSIDE_ACCEPTANCE_SCOPE:'No content decision recorded. This button is outside the current acceptance scenario; follow the next console instruction.',
 DETAILS:'No content decision recorded. Details messages are omitted from this session.',
 ALREADY_DECIDED:'This content version was already decided. No additional content decision recorded.',
 CONFLICTING_DECISION:'A different content decision already exists. No additional content decision recorded.',
 DUPLICATE_UPDATE:'This update was already processed. No additional content decision recorded.',
 DUPLICATE_CALLBACK:'This callback was already processed. No additional content decision recorded.',
};
export function acceptanceOutcome(target,action,status,updateId){
 return {event:'OPERATOR_OUTCOME',...target,action,buttonLabel:WRITING_BUTTONS[action],status,updateId,message:outcomes[status]??'No successful content decision confirmed. Follow the saved result before taking another action.'};
}

export function formatAcceptanceEvent(event){
 const target=()=>`Title: ${event.title}\nVersion: ${event.version}\nMessage ID: ${event.messageId}\nLocation: ${event.location}`;
 if(event.event==='OPERATOR_NEXT_ACTION'){
  const budget=Number.isSafeInteger(event.workingPollsRemaining)&&Number.isSafeInteger(event.apiSecondsRemaining)?`\nRemaining: ${event.workingPollsRemaining} working polls; ${event.apiSecondsRemaining} API seconds.`:'';
  return `NEXT ACTION — one click\n${target()}\nButton: ${event.buttonLabel}\nExpected result: ${event.expectedResult}\nPress this button once, then follow the recorded console result. You do not need to see a Telegram pop-up.${budget}`;
 }
 if(event.event==='OPERATOR_OUTCOME')return `RECORDED RESULT\n${target()}\nPressed: ${event.buttonLabel}\nResult: ${event.status}\n${event.message}\nThis outcome is saved locally. Telegram acknowledgment is pending; wait for the next console instruction.`;
 if(event.event==='OPERATOR_ACK_STATUS')return event.status==='API_CONFIRMED'?'Telegram acknowledgment API confirmed. This does not confirm that a pop-up was visible. The recorded console outcome remains authoritative.':'Telegram acknowledgment is uncertain. The local outcome above remains recorded. Stop here; no retry or next action is authorized.';
 return null;
}
