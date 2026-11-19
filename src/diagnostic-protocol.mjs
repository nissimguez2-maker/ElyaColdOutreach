import {CALLS} from './diagnostic-policy.mjs';
import {digest} from './values.mjs';
import {prepareOutputSchema} from './diagnostic-output-schema.mjs';
import {validateInstantlyResult} from './instantly-result.mjs';
export function validateReadTool(provider,tool){
 const call=CALLS.find(c=>c.provider===provider),s=tool?.inputSchema;
 if(!call||tool?.name!==call.tool||tool.annotations?.readOnlyHint===false||!s||s.type!=='object'||!s.properties)throw Error('RUNTIME_TOOL_MISMATCH');
 const rootKeys=['$schema','type','properties','required','additionalProperties','description','title'];
 if(Object.keys(s).some(k=>!rootKeys.includes(k))||Object.keys(s.properties).sort().join()!==Object.keys(call.arguments).sort().join()||(s.required??[]).some(k=>!(k in call.arguments)))throw Error('UNSUPPORTED_RUNTIME_SCHEMA');
 for(const [key,value] of Object.entries(call.arguments)){
  const p=s.properties[key],allowed=['type','format','description','title','default','minimum','maximum','minLength','maxLength','pattern','enum','const'];
  if(!p||Object.keys(p).some(k=>!allowed.includes(k)))throw Error('SCHEMA_KEYWORD_UNSUPPORTED');
  if(!(p.type===typeof value||p.type==='integer'&&Number.isInteger(value)))throw Error('SCHEMA_TYPE_MISMATCH');
  if('format'in p){
   if(p.format!=='uuid'||p.type!=='string')throw Error('UNSUPPORTED_SCHEMA_FORMAT');
   // Explicit UUID validation; do not silently ignore the format annotation.
   if(!/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(value))throw Error('SCHEMA_CONSTRAINT_MISMATCH');
  }
  if(p.enum&&!p.enum.includes(value)||'const'in p&&p.const!==value||typeof value==='number'&&(p.minimum!==undefined&&value<p.minimum||p.maximum!==undefined&&value>p.maximum)||typeof value==='string'&&(p.minLength!==undefined&&value.length<p.minLength||p.maxLength!==undefined&&value.length>p.maxLength||p.pattern&&!new RegExp(p.pattern).test(value)))throw Error('SCHEMA_CONSTRAINT_MISMATCH');
 }
 const contract={provider,schemaHash:digest(JSON.stringify(s)),inputSchema:s};
 if(provider==='instantly'){
  contract.outputSchemaPresent=Object.hasOwn(tool,'outputSchema');
  if(contract.outputSchemaPresent){contract.outputSchema=prepareOutputSchema(tool.outputSchema);contract.outputSchemaHash=digest(JSON.stringify(tool.outputSchema));}
  contract.resultExtraction='root structuredContent and/or root JSON text content; compare id/status across all representations';
 }
 return contract;
}
export function validateReadResult(provider,response,contract){
 if(provider==='instantly')return validateInstantlyResult(response,CALLS[1].arguments.id,contract).result;
 if(!response||response.isError===true)throw Error('PROVIDER_TOOL_ERROR');
 const call=CALLS.find(c=>c.provider===provider),key=provider==='apify'?'runId':'id',wanted=call.arguments[key],objects=[];
 function collect(value,depth=0){if(!value||typeof value!=='object'||depth>4)return;objects.push(value);for(const k of ['structuredContent','data','result'])collect(value[k],depth+1);if(Array.isArray(value.content))for(const part of value.content){if(part.type==='text'&&typeof part.text==='string'&&part.text.length<2000000){try{collect(JSON.parse(part.text),depth+1);}catch{}}}}
 collect(response);
 if(objects.some(x=>x.isError===true))throw Error('PROVIDER_TOOL_ERROR');
 const matches=objects.filter(x=>x[key]===wanted);
 if(!matches.length||objects.some(x=>typeof x[key]==='string'&&x[key]!==wanted))throw Error('RESOURCE_RESULT_MISMATCH');
 const states=matches.map(x=>x.status);
 if(states.some(x=>x===undefined)||new Set(states.map(String)).size!==1)throw Error('MISSING_OR_CONFLICTING_STATUS');
 const status=String(states[0]);
 if(provider==='apify'&&!['READY','RUNNING','TIMING-OUT','TIMED-OUT','ABORTING','ABORTED','SUCCEEDED','FAILED'].includes(status)||provider==='instantly'&&!/^\d{1,3}$/.test(status))throw Error('UNKNOWN_RESOURCE_STATUS');
 return {matchingResultEvidence:true,resourceStatus:status};
}
