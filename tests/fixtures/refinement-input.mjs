import {PHILADELPHIA_POLICY} from '../../src/refinement-policy.mjs';
// Synthetic inputs only. The 30/90-day test policy is not campaign policy.
export function fixture(){
 const entity={id:'SYN-1',type:'BUSINESS',name:'Synthetic Restaurant',address:'Synthetic Philadelphia location',domain:'example.test',identityState:'CONFIRMED',legacyHold:null};
 const input={entities:[entity],sources:[],claims:[],reviews:[],verifications:[],conflicts:[],retrieval:[],possibleMatches:[],existingHolds:[],suppressions:[],historicalSummary:null};
 const add=(predicate,value,entityId='SYN-1',extra={})=>{const id='source-'+input.sources.length;input.sources.push({id,document:value,kind:'DIRECT_PAGE',originId:id,url:'https://example.test/about',observedAt:'2026-11-16T10:00:00Z',publishedAt:null,provenance:{synthetic:true}});input.claims.push({entityId,predicate,value,sourceId:id,pointer:'',mode:'DIRECT',reviewId:null,entityMatch:'CONFIRMED',eventDate:null,limitations:[],...extra});};
 add('industry','Restaurant');add('city','Philadelphia');add('independent',true);add('operatingBy','2020-12-31');add('contact',{email:'qa@example.test',class:'GENERAL_BUSINESS',personId:null});
 const raw={email:'qa@example.test',status:'valid'};input.sources.push({id:'verifier-fixture',document:raw,kind:'PROVIDER_RESULT',originId:'synthetic-verifier',url:null,observedAt:'2026-11-16T10:00:00Z',publishedAt:null,provenance:{synthetic:true}});
 input.verifications.push({email:'qa@example.test',provider:'SYNTHETIC',raw,checkedAt:'2026-11-16T10:00:00Z',method:null,tier:null,sourceId:'verifier-fixture',pointer:''});input.suppressions.push({email:'qa@example.test',state:'CLEAR'});
 return {input,add,policy:{...PHILADELPHIA_POLICY,revision:'SYNTHETIC-POLICY-ONLY',verificationMaxAgeDays:30,eventMaxAgeDays:90}};
}
