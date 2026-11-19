// Offline payload preparation only. This module has no transport or provider capability.
import {latestBatch,evaluateRelease} from './batches.mjs';
import {evaluateWritingBatch,reviewVariables} from './writing.mjs';
import {getRecord,now} from './store.mjs';
export function prepareWritingHandoff(db,batchId,approvalId,at=now(),options={}){
 const batch=latestBatch(db,batchId);if(!batch)throw Error('Writing handoff batch missing');
 const content=JSON.parse(batch.content_json),writing=evaluateWritingBatch(db,content,at,options),release=evaluateRelease(db,batchId,approvalId,at,options);
 if(!writing.allowed||!release.allowed)throw Error([...writing.reasons,...release.reasons].join('; '));
 return {mode:options.fixtureAdapter?'ISOLATED_FIXTURE':'OFFLINE_PREPARED_ONLY',batchId,version:batch.version,hash:batch.hash,campaignId:content.campaignId,recipients:content.recipients.map(r=>({candidateId:r.candidateId,email:r.email,variables:reviewVariables(getRecord(db,'writing_packet',r.writing.packetHash))})),dispatchEnabled:false};
}
