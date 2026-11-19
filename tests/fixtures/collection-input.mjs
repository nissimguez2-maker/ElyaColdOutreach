import {fixture} from './refinement-input.mjs';
import {digest,canonical} from '../../src/values.mjs';

// Synthetic values using the saved rag-web-browser and bounceverify shapes.
// No provider success or price is asserted by these fixture values.
export function collectionFixture(){
 const f=fixture(),at='2026-11-16T20:00:00Z';
 const input={...f.input,sources:[],claims:[],reviews:[],verifications:[]};
 const document={crawl:{requestStatus:'handled',loadedAt:'2026-11-16T10:00:00Z',httpStatusCode:200,httpStatusMessage:'OK',uniqueKey:'fixture-page'},metadata:{url:'https://example.test/about',canonicalUrl:'https://example.test/about'},markdown:'Synthetic Restaurant is an independent restaurant in Philadelphia, operating since 2020. Contact qa@example.test.'};
 const run=(actor,datasetId,runId)=>({structuredContent:{runId,actorName:actor,status:'SUCCEEDED',startedAt:'2026-11-16T09:59:00Z',finishedAt:'2026-11-16T10:00:00Z',storages:{datasets:{default:{id:datasetId}}}},isError:false});
 const results=(datasetId,items)=>({structuredContent:{datasetId,items,itemCount:items.length,totalItemCount:items.length,offset:0,limit:10},isError:false});
 const page={id:'col-page',actor:'apify/rag-web-browser',run:run('apify/rag-web-browser','dataset-page','run-page'),results:results('dataset-page',[document]),sourceRef:'fixture:collection/page',receivedAt:at,targets:[{entityId:'SYN-1',url:'https://example.test/about'}]};
 const raw={email:'qa@example.test',status:'valid',score:100,syntax_valid:true,domain_exists:true,mx_found:true,smtp_valid:true,is_catch_all:false,is_disposable:false,is_role_based:false,is_free_provider:false,is_spamtrap:false,risk_type:'none',reason:'Fixture only',typo_suggestion:null,verified_at:'2026-11-16T10:00:00Z',mx_records:['mx.example.test']};
 const verification={id:'col-verification',actor:'bounceverify/bounceverify-email-verifier',run:run('bounceverify/bounceverify-email-verifier','dataset-verify','run-verify'),results:results('dataset-verify',[raw]),sourceRef:'fixture:collection/verification',receivedAt:at,targets:[{entityId:'SYN-1',email:'qa@example.test'}]};
 const values=[['industry','Restaurant'],['city','Philadelphia'],['independent',true],['operatingBy','2020-12-31'],['contact',{email:'qa@example.test',class:'GENERAL_BUSINESS',personId:null}]];
 const mappings=values.map(([predicate,value])=>({evidenceId:page.id,itemIndex:0,entityId:'SYN-1',predicate,value,pointer:'/markdown',mode:'REVIEWED',sourceValueHash:digest(canonical(document.markdown)),reviewedBy:'fixture-operator',note:'Synthetic fixture mapping reviewed against the exact page text.'}));
 const contact={...page,id:'col-contact',actor:'vdrmota/contact-info-scraper',run:run('vdrmota/contact-info-scraper','dataset-contact','run-contact'),results:results('dataset-contact',[{depth:0,originalStartUrl:'https://example.test/about',referrerUrl:null,url:'https://example.test/about',domain:'example.test',emails:['qa@example.test'],phones:[],phonesUncertain:[],linkedIns:[],twitters:[],instagrams:[],facebooks:[],youtubes:[],tiktoks:[],pinterests:[],discords:[],snapchats:[],threads:[],telegrams:[],reddits:[],whatsapps:[]}]),sourceRef:'fixture:collection/selected-contact-scraper'};
 const contactMapping={evidenceId:contact.id,itemIndex:0,entityId:'SYN-1',predicate:'contact',value:{email:'qa@example.test',class:'GENERAL_BUSINESS',personId:null},pointer:'/emails/0',mode:'REVIEWED',sourceValueHash:digest(canonical('qa@example.test')),reviewedBy:'fixture-operator',note:'Synthetic fixture general business route reviewed; no named mailbox controller inferred.'};
 return {input,policy:f.policy,asOf:at,page,verification,mappings,contact,contactMapping,spec:{id:'fresh-refinement',evidenceIds:[page.id,verification.id],input,mappings,policy:f.policy,asOf:at}};
}
