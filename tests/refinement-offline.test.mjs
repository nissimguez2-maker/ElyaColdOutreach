import test from 'node:test';import assert from 'node:assert/strict';
import http from 'node:http';import https from 'node:https';import net from 'node:net';import tls from 'node:tls';import dns from 'node:dns';import childProcess from 'node:child_process';
import {openStore} from '../src/store.mjs';import {processRefinement,renderRefinementReview} from '../src/refinement-store.mjs';import {fixture} from './fixtures/refinement-input.mjs';
test('processing and review rendering succeed with network, DNS and external-process capabilities denied',t=>{
 let attempts=0;const deny=()=>{attempts++;throw Error('OFFLINE_CAPABILITY_DENIED');};
 t.mock.method(globalThis,'fetch',deny);
 for(const [module,names]of [[http,['request','get']],[https,['request','get']],[net,['connect','createConnection']],[tls,['connect']],[dns,['lookup','resolve']],[childProcess,['spawn','spawnSync','exec','execFile','execSync','execFileSync']]])for(const name of names)t.mock.method(module,name,deny);
 const f=fixture(),db=openStore(':memory:');const result=processRefinement(db,f.input,f.policy,'2026-11-16T20:00:00Z','offline-capabilities');const review=renderRefinementReview(result);assert.ok(review.includes('QUALIFIED_FOR_REVIEW'));assert.ok(review.includes('No draft approval'));assert.equal(attempts,0);db.close();
});
