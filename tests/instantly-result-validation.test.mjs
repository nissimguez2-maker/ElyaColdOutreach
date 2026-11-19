import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {validateReadResult,validateReadTool} from '../src/diagnostic-protocol.mjs';
import {validateInstantlyResult} from '../src/instantly-result.mjs';
const captured=JSON.parse(readFileSync(new URL('./fixtures/instantly-campaign-result-minimized.json',import.meta.url)));
const tool=JSON.parse(readFileSync(new URL('./fixtures/instantly-get-campaign-schema-captured.json',import.meta.url)));
const id=captured.structuredContent.id;
const packet=obj=>({content:[],structuredContent:obj,isError:false});
test('unexpected numeric state retains exact identity and status without claiming application acceptance or connection failure',()=>{
 try{validateInstantlyResult(packet({id,status:1}),id);assert.fail('must reject');}catch(e){assert.equal(e.message,'CAMPAIGN_STATUS_UNSUPPORTED_VALUE');assert.deepEqual(e.observedCampaign,{id,status:1});assert.equal(e.campaignState,'UNEXPECTED_NUMERIC_STATUS');assert.equal(e.validation.protocol,'PASSED');assert.equal(e.validation.toolError,'NO_ERROR_REPORTED');assert.equal(e.validation.parsing,'PASSED');assert.equal(e.validation.application,'FAILED');}
 assert.deepEqual(validateInstantlyResult(captured,id).observedCampaign,{id,status:0});
 for(const value of [true,[0],'0',null]){try{validateInstantlyResult(packet({id,status:value}),id);assert.fail('must reject');}catch(e){assert.equal(e.observedCampaign,undefined);}}
});
test('captured root representations and legitimate numeric zero pass without coercion',()=>{assert.deepEqual(validateReadResult('instantly',captured),{matchingResultEvidence:true,resourceStatus:'0'});assert.ok(validateReadResult('instantly',packet({id,status:0,optionalFutureField:'ignored'})));});
for(const status of [[0],{},true,false,null,'0'])test(`reject status wrong type ${JSON.stringify(status)}`,()=>assert.throws(()=>validateReadResult('instantly',packet({id,status})),/CAMPAIGN_STATUS_WRONG_TYPE/));
test('missing and unsupported status are separate',()=>{assert.throws(()=>validateReadResult('instantly',packet({id})),/CAMPAIGN_STATUS_MISSING/);for(const status of [1,-1,999,0.5])assert.throws(()=>validateReadResult('instantly',packet({id,status})),/CAMPAIGN_STATUS_UNSUPPORTED_VALUE/);});
test('IDs have separate missing, type, unsupported, mismatch and conflict outcomes',()=>{
 assert.throws(()=>validateReadResult('instantly',packet({status:0})),/CAMPAIGN_ID_MISSING/);
 for(const value of [null,0,true,[id],{}])assert.throws(()=>validateReadResult('instantly',packet({id:value,status:0})),/CAMPAIGN_ID_WRONG_TYPE/);
 assert.throws(()=>validateReadResult('instantly',packet({id:'not-uuid',status:0})),/CAMPAIGN_ID_UNSUPPORTED_VALUE/);
 assert.throws(()=>validateReadResult('instantly',packet({id:'00000000-0000-0000-0000-000000000000',status:0})),/CAMPAIGN_ID_MISMATCH/);
 const conflict=structuredClone(captured);conflict.content[0].text=JSON.stringify({id:'00000000-0000-0000-0000-000000000000',status:0});assert.throws(()=>validateReadResult('instantly',conflict),/CAMPAIGN_ID_CONFLICT/);
});
test('status conflicts are not hidden by choosing the supported value',()=>{const r=structuredClone(captured);r.content[0].text=JSON.stringify({id,status:1});assert.throws(()=>validateReadResult('instantly',r),/CAMPAIGN_STATUS_CONFLICT/);});
test('conflicting shared optional values fail but a new optional field alone does not',()=>{const r=structuredClone(captured);r.structuredContent.extra='one';assert.ok(validateReadResult('instantly',r));r.content[0].text=JSON.stringify({id,status:0,extra:'two'});assert.throws(()=>validateReadResult('instantly',r),/RESULT_REPRESENTATION_CONFLICT/);});
test('no recursive identity search, prose proof or malformed parallel representation',()=>{
 assert.throws(()=>validateReadResult('instantly',packet({data:{id,status:0}})),/CAMPAIGN_ID_MISSING/);
 for(const text of ['Read succeeded','```json\n{}\n```','{broken']){const r=structuredClone(captured);r.content[0].text=text;assert.throws(()=>validateReadResult('instantly',r),/RESULT_TEXT_INVALID_JSON/);}
 assert.throws(()=>validateReadResult('instantly',{content:[{type:'text',text:JSON.stringify([{id,status:0}])}]}),/RESULT_ENVELOPE_WRONG_TYPE/);
});
test('protocol, tool error, parsing and application errors retain separate layers',()=>{
 for(const [r,reason,layer]of [[{structuredContent:{id,status:0}},'PROTOCOL_CONTENT_MISSING','protocol'],[{...captured,isError:'false'},'PROTOCOL_ERROR_FLAG_WRONG_TYPE','protocol'],[{...captured,isError:true},'PROVIDER_TOOL_ERROR','toolError'],[{content:[{type:'text',text:'prose'}]},'RESULT_TEXT_INVALID_JSON','parsing'],[packet({id,status:true}),'CAMPAIGN_STATUS_WRONG_TYPE','application']]){
  try{validateReadResult('instantly',r);assert.fail('must reject');}catch(e){assert.equal(e.message,reason);assert.equal(e.validation[layer],'FAILED');}
 }
});
test('optional outputSchema absence passes and supported present schema is enforced',()=>{
 const absent=validateReadTool('instantly',tool);assert.equal(absent.outputSchemaPresent,false);
 const declared={type:'object',properties:{id:{type:'string'},status:{type:'integer',enum:[0]},optional:{type:'string'}},required:['id','status'],additionalProperties:true};
 const contract=validateReadTool('instantly',{...tool,outputSchema:declared});assert.equal(contract.outputSchemaPresent,true);
 assert.ok(validateReadResult('instantly',captured,contract));
 assert.throws(()=>validateReadResult('instantly',packet({id,status:0,optional:5}),contract),/OUTPUT_SCHEMA_RESULT_MISMATCH/);
 assert.throws(()=>validateReadResult('instantly',{content:captured.content},contract),/OUTPUT_SCHEMA_STRUCTURED_RESULT_MISSING/);
});
test('unknown or invalid output schema constraints stop before dispatch',()=>{
 for(const outputSchema of [null,{type:'object',$ref:'https://fixture.invalid/schema'},{type:'object',unknownConstraint:true},{type:'object',properties:{status:{type:'integer',minimum:'0'}}}])assert.throws(()=>validateReadTool('instantly',{...tool,outputSchema}),/OUTPUT_SCHEMA_UNSUPPORTED/);
});
