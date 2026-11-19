import {writingTelegramFixture,at} from './telegram-writing-fixture.mjs';
import {getRecord,putRecord} from '../../src/store.mjs';
import {prepareWritingReview} from '../../src/writing.mjs';
export {at};
export function firstTouchFixture(path=':memory:'){
 const f=writingTelegramFixture(path);
 f.spec={...f.spec,contractVersion:'first-touch-only-v1',draftIds:f.spec.draftIds.slice(0,1),steps:f.spec.steps.slice(0,1)};
 const p=getRecord(f.db,'writing_policy',f.spec.campaignId);
 putRecord(f.db,'writing_policy',f.spec.campaignId,{...p,revision:'fixture-first-touch-v1',sequence:{steps:1,endpoint:'END_AFTER_FIRST_TOUCH',endpointApproved:true},approvalExpiry:{approved:true,approvedBy:p.approver,approvedAt:at,revision:'fixture-calendar-v1',maxCalendarDays:7,timeZone:'America/New_York'}});
 f.packet=prepareWritingReview(f.db,f.spec);return f;
}
