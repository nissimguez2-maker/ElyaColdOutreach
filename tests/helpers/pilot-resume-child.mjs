import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {openStore,putRecord} from '../../src/store.mjs';
import {digest,canonical} from '../../src/values.mjs';
import {INACTIVE_SETUP_ID,INACTIVE_LEAD_COPY_SOURCES,buildInactiveLeadCopyManifest} from '../../src/instantly-pilot-scope.mjs';
import {runLeadCopyHost} from '../../src/instantly-pilot-resume-cli.mjs';
const directory=process.argv[2],root=resolve('.'),db=openStore(join(directory,'fixture.sqlite'));
if(process.argv[3]==='claim-refusal')db.exec("CREATE TRIGGER fixture_claim_refusal BEFORE INSERT ON journal WHEN NEW.event='INACTIVE_SETUP_STARTED' BEGIN SELECT RAISE(ABORT,'FIXTURE_CLAIM_REFUSED'); END;");
putRecord(db,'acceptance_authorization',INACTIVE_SETUP_ID,{id:INACTIVE_SETUP_ID,status:'CLOSED'});
putRecord(db,'acceptance_result',INACTIVE_SETUP_ID,{authorizationStatus:'CLOSED',campaignReadback:'VERIFIED'});
putRecord(db,'contact','fixture',{held:true});putRecord(db,'draft','fixture',{approved:false});
const manifest=buildInactiveLeadCopyManifest(readFileSync(join(root,'work/inactive-one-step-pilot-v1/proposal.json'),'utf8'));
const preparation={manifestHash:digest(canonical(manifest)),sourceFingerprints:INACTIVE_LEAD_COPY_SOURCES.map(path=>({path,sha256:digest(readFileSync(join(root,path)))}))};
try{
 const result=await runLeadCopyHost({root,db,directory:join(directory,'run'),preparation,approvalReference:'OFFLINE FIXTURE ONLY'});
 writeFileSync(join(directory,'child-result.json'),JSON.stringify(result));process.exitCode=result.result.status==='PASS'?0:2;
}finally{db.close();}
