// Harmless stand-in for a CLI executable. No network or credential access.
import { readFileSync } from 'node:fs';
const mode = process.argv[2];
const schemaIndex = process.argv.indexOf('--output-schema');
if (schemaIndex < 0 || !process.argv.includes('read-only')) process.exit(4);
const schema = JSON.parse(readFileSync(process.argv[schemaIndex + 1], 'utf8'));
if (schema.additionalProperties !== false) process.exit(5);
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
// Self-expiry prevents a test child lingering if the host refuses termination.
if (mode === 'hang') { setTimeout(() => process.exit(0), 600); }
else if (mode === 'flood') { process.stdout.write('x'.repeat(300000)); }
else {
  const resourceId = schema.properties.resourceId.const;
  if (!prompt.includes(resourceId)) process.exit(6);
  const item = { id:'local_call',type:'mcp_tool_call',server:'apify',tool:'get-actor-run',arguments:{runId:resourceId,waitSecs:0} };
  for(const event of [
    {type:'turn.started'},
    {type:'item.started',item:{...item,status:'in_progress'}},
    {type:'item.completed',item:{...item,status:'completed',result:{structured_content:{runId:resourceId,status:'SUCCEEDED'}}}},
    {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({version:1,provider:'apify',action:'get_actor_run',resourceId,outcome:'SUCCEEDED',resourceStatus:'SUCCEEDED'})}},
    {type:'turn.completed'}
  ]) process.stdout.write(JSON.stringify(event)+'\n');
}
