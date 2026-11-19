import {checkOutputSchema} from './diagnostic-output-schema.mjs';
import {isDeepStrictEqual} from 'node:util';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Source: work/instantly-capability-inspection.json / snapshot.campaign.value.
// Only numeric 0 is established locally; other provider enum values are unknown.
export function validateInstantlyResult(response,wanted,contract={outputSchemaPresent:false}){
 const validation={protocol:'NOT_RUN',toolError:'NOT_RUN',parsing:'NOT_RUN',outputSchema:'NOT_RUN',application:'NOT_RUN'};
 let observedCampaign;
 const fail=(layer,reason)=>{validation[layer]='FAILED';const e=Error(reason);e.validation={...validation};if(observedCampaign){e.observedCampaign=observedCampaign;e.campaignState='UNEXPECTED_NUMERIC_STATUS';}throw e;};
 if(!object(response))fail('protocol','PROTOCOL_RESULT_WRONG_TYPE');
 if(!Object.hasOwn(response,'content'))fail('protocol','PROTOCOL_CONTENT_MISSING');
 if(!Array.isArray(response.content))fail('protocol','PROTOCOL_CONTENT_WRONG_TYPE');
 if(Object.hasOwn(response,'isError')&&response.isError!==null&&typeof response.isError!=='boolean')fail('protocol','PROTOCOL_ERROR_FLAG_WRONG_TYPE');
 if(response.content.some(p=>!object(p)||typeof p.type!=='string'||p.type==='text'&&typeof p.text!=='string'))fail('protocol','PROTOCOL_CONTENT_ITEM_INVALID');
 validation.protocol='PASSED';
 if(response.isError===true)fail('toolError','PROVIDER_TOOL_ERROR');
 validation.toolError=response.isError===false?'NO_ERROR_REPORTED':'ERROR_FLAG_ABSENT_OR_NULL';
 const representations=[];
 if(Object.hasOwn(response,'structuredContent')){
  if(!object(response.structuredContent))fail('parsing','RESULT_ENVELOPE_WRONG_TYPE');
  representations.push(response.structuredContent);
 }
 for(const part of response.content){
  if(part.type!=='text')continue;
  if(part.text.length>2000000)fail('parsing','RESULT_TEXT_TOO_LARGE');
  let parsed;try{parsed=JSON.parse(part.text);}catch{fail('parsing','RESULT_TEXT_INVALID_JSON');}
  if(!object(parsed))fail('parsing','RESULT_ENVELOPE_WRONG_TYPE');
  representations.push(parsed);
 }
 if(!representations.length)fail('parsing','RESULT_REPRESENTATION_MISSING');
 validation.parsing='PASSED';
 if(contract.outputSchemaPresent){
  if(!Object.hasOwn(response,'structuredContent'))fail('outputSchema','OUTPUT_SCHEMA_STRUCTURED_RESULT_MISSING');
  if(!checkOutputSchema(contract.outputSchema,response.structuredContent))fail('outputSchema','OUTPUT_SCHEMA_RESULT_MISMATCH');
  validation.outputSchema='PASSED';
 }else validation.outputSchema='NOT_ADVERTISED';
 for(const r of representations){
  if(!Object.hasOwn(r,'id'))fail('application','CAMPAIGN_ID_MISSING');
  if(typeof r.id!=='string')fail('application','CAMPAIGN_ID_WRONG_TYPE');
  if(!Object.hasOwn(r,'status'))fail('application','CAMPAIGN_STATUS_MISSING');
  if(typeof r.status!=='number'||!Number.isFinite(r.status))fail('application','CAMPAIGN_STATUS_WRONG_TYPE');
 }
 if(new Set(representations.map(r=>r.id)).size!==1)fail('application','CAMPAIGN_ID_CONFLICT');
 if(new Set(representations.map(r=>r.status)).size!==1)fail('application','CAMPAIGN_STATUS_CONFLICT');
 for(let i=0;i<representations.length;i++)for(let j=i+1;j<representations.length;j++){
  for(const key of Object.keys(representations[i]))if(Object.hasOwn(representations[j],key)&&!isDeepStrictEqual(representations[i][key],representations[j][key]))fail('application','RESULT_REPRESENTATION_CONFLICT');
 }
 const r=representations[0];
 if(!uuid.test(r.id))fail('application','CAMPAIGN_ID_UNSUPPORTED_VALUE');
 if(r.id!==wanted)fail('application','CAMPAIGN_ID_MISMATCH');
 observedCampaign={id:r.id,status:r.status};
 if(r.status!==0)fail('application','CAMPAIGN_STATUS_UNSUPPORTED_VALUE');
 validation.application='PASSED';
 return {result:{matchingResultEvidence:true,resourceStatus:'0'},validation,observedCampaign};
}
