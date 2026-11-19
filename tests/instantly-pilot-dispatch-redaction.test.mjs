import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertSafe} from '../src/values.mjs';
test('actual dispatcher rejects credential-bearing raw results before persistence including embedded provider JSON',()=>{
 const source=readFileSync('work/inactive-lead-copy-v1/dispatch-reviewed.js','utf8');
 // Execute only the actual result validator, never the live dispatch block.
 const validate=new Function('v',source.slice(source.indexOf('const safe='),source.indexOf("if(expected?.id"))+'return safe(v);');
 const values=[{structuredContent:{client_secret:'fixture-sensitive'}},{refresh_token:'fixture'}, {passwd:'fixture'},{bot_token:'fixture'},{content:[{type:'text',text:'{"authorization":"fixture"}'}]}, {text:'-----BEGIN PRIVATE KEY-----'}, {text:'https://user:fixture@example.invalid/'}, {text:'Bearer fixture'}];
 for(const value of values){assert.throws(()=>assertSafe(value));assert.throws(()=>validate(value));}
 assert.doesNotThrow(()=>validate({content:[{type:'text',text:'Synthetic café copy'}],structuredContent:{id:'fixture',status:0},isError:false}));
});
