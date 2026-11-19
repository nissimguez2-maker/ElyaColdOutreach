import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepareOutputSchema,checkOutputSchema} from '../src/diagnostic-output-schema.mjs';

test('propertyNames applies the declared schema to every object key',()=>{
 const s={type:'object',propertyNames:{type:'string',pattern:'^pilot_',minLength:7},additionalProperties:{type:'string'}};
 prepareOutputSchema(s);
 assert.equal(checkOutputSchema(s,{pilot_a:'ok'}),true);
 assert.equal(checkOutputSchema(s,{other:'bad'}),false);
 assert.equal(checkOutputSchema(s,{pilot_:'short'}),false);
 assert.equal(checkOutputSchema(s,{pilot_a:7}),false);
 assert.equal(checkOutputSchema(s,{}),true);
});

test('saved successful campaign contract remains supported',()=>{
 const saved=JSON.parse(readFileSync('work/connector-compatibility/live-functional-v5/runtime-schemas.json','utf8'))[0];
 prepareOutputSchema(saved.inputSchema);prepareOutputSchema(saved.outputSchema);
 assert.equal(checkOutputSchema(saved.inputSchema,{id:'339a5dbc-075c-4745-9a38-c11a26c5d920'}),true);
 assert.equal(checkOutputSchema(saved.inputSchema,{id:[0]}),false);
});

test('unsupported and malformed nested property-name contracts retain exact diagnostic paths',()=>{
 for(const [schema,path,category]of [
  [{type:'object',propertyNames:{format:'email'}},'/inputSchema/propertyNames/format','UNSUPPORTED'],
  [{type:'object',propertyNames:[]},'/inputSchema/propertyNames','MALFORMED'],
 ])assert.throws(()=>prepareOutputSchema(schema,{tool:'instantly_ai.update_lead',side:'input'}),e=>{
  assert.equal(e.schemaFailure.path,path);assert.equal(e.schemaFailure.category,category);return true;
 });
});
