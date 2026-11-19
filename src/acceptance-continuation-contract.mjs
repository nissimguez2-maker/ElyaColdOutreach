import {canonical,digest} from './values.mjs';

export const CONTINUATION_ID='elya-acceptance-continuation-v1';
export const CONTINUATION_MANIFEST_HASH='84153b71d9665ca2d349af094bae0a80c960c3854f914e41dd961cd71df4b46f';

// Exact reviewed scope only. This is not a configurable/general dispatch policy.
export function validateContinuationManifest(manifest){
 if(manifest?.id!==CONTINUATION_ID||digest(canonical(manifest))!==CONTINUATION_MANIFEST_HASH)throw Error('CONTINUATION_MANIFEST_MISMATCH');
 return manifest;
}
