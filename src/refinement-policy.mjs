// Campaign policy only; source content and provider suggestions cannot replace it.
export const PHILADELPHIA_POLICY=Object.freeze({
 revision:'PHL-restaurant-refinement-v1',campaignId:'339a5dbc-075c-4745-9a38-c11a26c5d920',
 industry:'Restaurant',city:'Philadelphia',country:'US',excludedStates:['TX','CA'],minimumOperatingYears:2,
 independenceRequired:true,outsideCityDisposition:'HOLD',
 allowedContactClasses:['DIRECT_PERSON','BUSINESS_ROLE','GENERAL_BUSINESS','GROUP_SHARED'],
 verificationAccepted:['VALID'],verificationMaxAgeDays:null,evidenceMaxAgeDays:null,eventMaxAgeDays:null,
 preferences:['Supported decision-maker/influencer route','LLC preferred, not required','Confident individual LinkedIn optional'],
 provenance:[
  {source:'User initial project handoff, BUSINESS CRITERIA',reference:'attachment:c93e43e0-43cc-427c-a475-e62c40e440a8'},
  {source:'Elya-Partners-Cold-Outreach-Brain.md v1 sections 3–5',reference:'user-designated business reference'},
  {source:'User Philadelphia pilot amendments',reference:'Philadelphia city; Bruno held; small independent groups allowed; verified generic inboxes acceptable'},
  {source:'User verification diagnosis and current consolidated brief',reference:'Keep two contacts held; catch-all not passing; no automatic rerun; freshness unresolved'}
 ],
 unresolved:['Verification freshness interval','General evidence freshness by claim type','Event recency interval for timely prioritization'],
 budgetNote:'Existing GPT subscription excluded under prior explicit policy; other model costs included. No spending authority.'
});
