// Invented local fixture protocol. These keys are NOT Instantly API fields.
export const fixtureReplyContract={id:'synthetic-reply-contract-v1',version:1,provider:'instantly',basis:'SYNTHETIC_FIXTURE',scope:'EXACT_CAMPAIGN',pagination:'OPAQUE_CURSOR_NULL_END',evidence:{request:'fixture:exact-campaign-request',response:'fixture:invented-response',pagination:'fixture:opaque-cursor',identity:'fixture:event-and-lead-identity',timestamps:'fixture:ISO-8601',cost:'fixture:zero-cost'}};
export function decodeFixtureReplyPage(payload,{campaignId,evidenceRef}){
 if(!payload||Object.keys(payload).sort().join(',')!=='fixtureCursor,fixtureReplies'||!Array.isArray(payload.fixtureReplies))throw Error('FIXTURE_REPLY_SHAPE');
 return {nextCursor:payload.fixtureCursor,events:payload.fixtureReplies.map(item=>({version:1,provider:'instantly',eventId:item.fixtureId,type:'REPLIED',campaignId:item.fixtureCampaign??campaignId,leadId:item.fixtureLead,email:item.fixtureEmail,occurredAt:item.fixtureTime,evidenceRef,excerpt:item.fixtureText}))};
}
export const fixtureReplyPayload=(cursor=null)=>({fixtureCursor:cursor,fixtureReplies:[{fixtureId:'fixture-reply-1',fixtureLead:'fixture-lead',fixtureEmail:'qa@example.invalid',fixtureTime:'2026-11-16T17:00:00Z',fixtureText:'Synthetic reply for local tests only.'}]});
