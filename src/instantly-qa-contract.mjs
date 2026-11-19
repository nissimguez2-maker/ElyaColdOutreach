import {canonical,digest} from './values.mjs';

export const INSTANTLY_QA_ID='elya-instantly-qa-acceptance-v1';
export const INSTANTLY_QA_MANIFEST_HASH='7187798fabd6e2169f2e476bbd74b81dd43d81dbb9bdfbe3cff1688b92b52229';
export const INSTANTLY_QA_V2_ID='elya-instantly-qa-acceptance-v2';
export const INSTANTLY_QA_V2_MANIFEST_HASH='17aba6391533f3052ebc0e996ebcf52d1829a3b802131ca0b1c4a3665d4a7767';
export const isInstantlyQaId=id=>id===INSTANTLY_QA_ID||id===INSTANTLY_QA_V2_ID;
export function instantlyQaRelativeDirectory(id){
 if(!isInstantlyQaId(id))throw Error('INSTANTLY_QA_MANIFEST_MISMATCH');
 return id===INSTANTLY_QA_V2_ID?'work/instantly-qa-acceptance-v2':'work/instantly-qa-acceptance-v1';
}

// Exact approved one-use scope. This does not create or activate authority.
export function validateInstantlyQaManifest(manifest){
 const expected=manifest?.id===INSTANTLY_QA_V2_ID?INSTANTLY_QA_V2_MANIFEST_HASH:INSTANTLY_QA_MANIFEST_HASH;
 if(!isInstantlyQaId(manifest?.id)||digest(canonical(manifest))!==expected)throw Error('INSTANTLY_QA_MANIFEST_MISMATCH');
 return manifest;
}
