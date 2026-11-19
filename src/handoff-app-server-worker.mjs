// Fixed entry for work/connector-compatibility/owner.ps1; no standalone CLI.
import {runContainedHandoffWorker} from './handoff-app-server.mjs';
if(process.argv[2]!=='parent'||!process.argv[3])throw Error('HANDOFF_CONTAINED_ENTRY_REQUIRED');
await runContainedHandoffWorker(process.argv[3]);
// The outside owner kills and verifies the entire owned process tree.
setInterval(()=>{},1000);
