import {canonical,digest} from './values.mjs';
export const DETAILS_ID='telegram-details-only-v1';
export const TEST_MESSAGE="SYNTHETIC QA — Details callback test\nTest: qa-details-v1 • Version 1\n\nPress Details once to request the synthetic details.\n\nThis is not a prospect review. Business remains stopped. No approval or sending is authorized.";
export const DETAILS_RESPONSE="SYNTHETIC QA — Details response\nTest: qa-details-v1 • Version 1\n\nSynthetic content: café, equipment & catering; the owner's checklist.\n\nNo content approval was recorded. Business remains stopped. No campaigns, provider jobs or outreach were launched.";
export const DETAILS_LIMITS=Object.freeze({totalMs:120000,apiMs:110000,requests:16,polls:11,pollGapMs:5000});
export const detailsCardHash=()=>digest(canonical({id:DETAILS_ID,version:1,message:TEST_MESSAGE,details:DETAILS_RESPONSE,button:'Details',limits:DETAILS_LIMITS}));
export function renderDetailsProbe(review){
 if(!/^wr_[A-Za-z0-9_-]{22}$/.test(review?.actions?.DETAILS)||review.syntheticOnly!==true)throw Error('SYNTHETIC_DETAILS_REFERENCE_REQUIRED');
 return {text:TEST_MESSAGE,reply_markup:{inline_keyboard:[[{text:'Details',callback_data:review.actions.DETAILS}]]}};
}
