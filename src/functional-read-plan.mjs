// Preparation only. This does not create an authorization or expose a live CLI mode.
export function functionalReadPlan(startedMs){
 if(!Number.isSafeInteger(startedMs)||startedMs<0)throw Error('INVALID_START_TIME');
 return {
  executionAuthorized:false,server:'codex_apps',tool:'instantly_ai.get_campaign',arguments:{id:'339a5dbc-075c-4745-9a38-c11a26c5d920'},
  readinessDeadlineAt:new Date(startedMs+20000).toISOString(),deadlineAt:new Date(startedMs+40000).toISOString(),hardDeadlineAt:new Date(startedMs+60000).toISOString(),
  statusRequestLimit:10,toolRequestLimit:1,waitForReadiness:true,intervalMs:2000,
  retry:false,replay:false,fallback:false,sameThreadRequired:true,
  acceptedStatusType:'number',acceptedStatusValues:[0],resultPath:'root structuredContent and/or root JSON text content',
 };
}
