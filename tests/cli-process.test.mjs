import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, createBudget, operation, beginOperation, recoverOperations } from '../src/foundation.mjs';
import { registerCliJob, approveOfflineCliJob, executeCliJob } from '../src/cli-adapter.mjs';
const processApi = await import('../src/cli-process.mjs').catch(() => null);
test('replaceable CLI process driver is available', () => assert.ok(processApi));
const fixture = fileURLToPath(new URL('./fixtures/cli-process.mjs',import.meta.url));
const at='2026-11-16T16:00:00Z';
function setup(timeoutMs=2000) {
  const dir=mkdtempSync(join(tmpdir(),'elya-cli-')),path=join(dir,'state.sqlite'),db=openStore(path);
  createBudget(db,'b','1','0','0');
  const job={version:1,id:'local-child',provider:'apify',action:'get_actor_run',resourceId:'D2oXFE4Ns5FRBEQha',timeoutMs,budgetId:'b',reservationUsd:'0.1'};
  registerCliJob(db,job);approveOfflineCliJob(db,job.id,{actorRef:'offline-test',expiresAt:'2026-11-17T00:00:00Z',allowWhileStopped:true},at);
  return{db,dir,path,job};
}
if(processApi) {
  test('real offline child receives structured schema and reports tool evidence without any provider call',async()=>{
    const{db,dir,job}=setup();
    const transport=processApi.createCliProcessTransport({executable:process.execPath,prefixArgs:[fixture,'read'],mode:'offline',workingDirectory:dir});
    const result=await executeCliJob(db,job.id,transport,()=>at);
    assert.equal(result.readOutcome,'SUCCEEDED');assert.equal(result.processOutcome,'EXITED_ZERO');assert.match(result.toolEvidence.callIdHash,/^[a-f0-9]{64}$/);db.close();
  });
  test('real delayed child hits deadline and stays unresolved even if tree termination is unconfirmed',async()=>{
    const{db,dir,job}=setup(100);
    const transport=processApi.createCliProcessTransport({executable:process.execPath,prefixArgs:[fixture,'hang'],mode:'offline',workingDirectory:dir});
    const result=await executeCliJob(db,job.id,transport,()=>at);
    assert.equal(result.processOutcome,'TIMEOUT');assert.equal(typeof result.terminationConfirmed,'boolean');assert.equal(result.readOutcome,'UNRESOLVED');assert.equal(operation(db,`cli:${job.id}`).status,'RECONCILIATION');db.close();
  });
  test('default live process driver cannot be dispatched by the adapter',async()=>{
    const{db,dir,job}=setup();
    const transport=processApi.createCliProcessTransport({executable:process.execPath,prefixArgs:[fixture,'read'],workingDirectory:dir});
    await assert.rejects(executeCliJob(db,job.id,transport,()=>at),/LIVE_DISPATCH_DISABLED/);assert.equal(operation(db,`cli:${job.id}`),undefined);db.close();
  });
  test('restart with dispatch journal cannot launch another process',async()=>{
    const{db,path,job}=setup();
    const {reserveOperation}=await import('../src/operations.mjs');
    reserveOperation(db,{id:`cli:${job.id}`,kind:'READ',budgetId:job.budgetId,reservation:job.reservationUsd,authorizationRef:`cli_job_authorization:${job.id}`,payload:{provider:job.provider,action:job.action,resourceId:job.resourceId}});
    beginOperation(db,`cli:${job.id}`,at);db.close();
    const reopened=openStore(path);recoverOperations(reopened);let calls=0;
    await assert.rejects(executeCliJob(reopened,job.id,{mode:'offline',start(){calls++;throw Error('must not run');}},()=>at));
    assert.equal(calls,0);assert.equal(operation(reopened,`cli:${job.id}`).status,'RECONCILIATION');reopened.close();
  });
}
