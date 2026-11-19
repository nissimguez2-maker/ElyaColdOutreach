import {runInstantlyQaCommand} from './instantly-qa-command.mjs';
import {INSTANTLY_QA_V2_ID} from './instantly-qa-contract.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {acceptanceErrorCode} from './acceptance-controller.mjs';

// These are execution-context guards, not proof of a human identity. No caller
// supplied prompt, provider response or environment value grants authorization.
export function assertInstantlyQaOperatorEntry(runtime){
 if(!Array.isArray(runtime?.args)||runtime.args.length!==1||runtime.args[0]!=='--run-once')throw Error('USE_RUN_ONCE_ARGUMENT_ONLY');
 if(runtime.platform!=='win32'||runtime.stdinIsTTY!==true||runtime.stdoutIsTTY!==true)throw Error('NORMAL_USER_INTERACTIVE_POWERSHELL_REQUIRED');
 if(runtime.agentContext!==false||runtime.background!==false)throw Error('AGENT_OR_BACKGROUND_ENTRY_NOT_AUTHORIZED');
 return true;
}

// Both the fixed CLI and isolated CLI fixtures use this exact orchestration.
// No production CLI flag permits selecting a transport or alternate database.
export async function runInstantlyQaV2Entry({runtime,...options}){
 const result=await runInstantlyQaCommand({...options,authorizationId:INSTANTLY_QA_V2_ID,entryCheck:()=>assertInstantlyQaOperatorEntry(typeof runtime==='function'?runtime():runtime)});
 return {...result,exitCode:result.status==='PASS'&&!result.localReportError&&!result.attemptEvidenceError?0:2};
}

// Opening the authoritative database can fail before the shared command exists.
// Preserve that invocation without guessing its grant state or touching authority.
export function recordInstantlyQaOpenRefusal({root,error,startedAtMs,now=Date.now}){
 const result={id:INSTANTLY_QA_V2_ID,attemptId:randomUUID(),startedAt:new Date(startedAtMs).toISOString(),finishedAt:new Date(now()).toISOString(),status:'BLOCKED',reason:acceptanceErrorCode(error),firstFailingStage:'LOCAL_CLI_OPEN',authorizationStatus:'NOT_READ',attemptExternalActivity:'NOT_STARTED',noAutomaticRetry:true,exitCode:2};
 try{
  const directory=join(root,'work/instantly-qa-acceptance-v2/attempts');mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,`${result.attemptId}.result.json`),JSON.stringify(result,null,2),{flag:'wx',flush:true});
 }catch{result.attemptEvidenceError='INSTANTLY_QA_ATTEMPT_EVIDENCE_PERSISTENCE_FAILED';}
 return result;
}
