import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const {createPilotFileHandoff}=await import('../../src/instantly-pilot-host.mjs');
const [directory,mode]=process.argv.slice(2),handoff=createPilotFileHandoff(directory);
let timer;
try{
 if(mode==='abort')timer=setTimeout(()=>handoff.close(),150);
 const response=await handoff.invoke({server:'codex_apps',tool:'instantly_ai.update_lead',arguments:{id:'synthetic',custom_variables:{pilot_body_1:'café & owner\'s\n'.repeat(2000)}}},{index:2,deadlineAt:new Date(Date.now()+4000).toISOString()});
 writeFileSync(join(directory,'child-result.json'),JSON.stringify(response));
}catch(e){writeFileSync(join(directory,'child-result.json'),JSON.stringify({reason:e.message}));}
finally{clearTimeout(timer);handoff.close();}
