import {canonical,digest} from './values.mjs';

export const DISCOVERY_CAPTURE_ID='elya-instantly-contract-capture-v1';
export const DISCOVERY_DIRECTORY='work/instantly-contract-capture-v1';
export const DISCOVERY_TOOLS=Object.freeze(['instantly_ai.create_lead','instantly_ai.list_emails']);
const profile={
 id:DISCOVERY_CAPTURE_ID,profile:'INSTANTLY_SELECTED_CONTRACT_DISCOVERY_ONLY',server:'codex_apps',targets:[...DISCOVERY_TOOLS],
 limits:{maxContainedLaunches:1,totalMs:60000,readinessMs:20000,discoveryMs:40000,maxStatusRequests:10,statusIntervalMs:2000,maxBusinessCalls:0,retries:false,replay:false,fallback:false,restart:false,automaticRearming:false},
 authorizationPlan:{validityMs:86400000,minimumRemainingAtLaunchMs:150000,operatorLaunchOnly:true},
 capture:{completeAdvertisedObjects:true,beforeValidation:true,unrelatedTools:false,credentials:false},
 money:{createBudget:false,createReservation:false},
 businessLaunchAuthorized:false,generalDispatchEnabled:false,
};
// An explicit immutable profile, not a caller-configurable dispatch policy.
const encoded=canonical(profile);
export const DISCOVERY_MANIFEST_HASH=digest(encoded);
export const DISCOVERY_MANIFEST=Object.freeze(JSON.parse(encoded));
export function validateDiscoveryManifest(value){
 if(canonical(value)!==encoded)throw Error('DISCOVERY_MANIFEST_MISMATCH');
 return value;
}
