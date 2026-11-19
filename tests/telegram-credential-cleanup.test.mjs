import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {mkdtempSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readProtected} from '../src/windows-protected-storage.mjs';import {blockNetwork} from './helpers/network-block.mjs';
function fakeProcess(closes){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.closed=false;child.kills=0;child.kill=()=>{child.kills++;if(closes)setTimeout(()=>{child.closed=true;child.emit('close',1);},10);return true;};return child;}
for(const closes of [true,false])test(`credential helper timeout requires observed child close: closes=${closes}`,async t=>{
 blockNetwork(t);const path=join(mkdtempSync(join(tmpdir(),'elya-credential-cleanup-')),'synthetic.dpapi');writeFileSync(path,'aabbcc');const child=fakeProcess(closes);
 await assert.rejects(readProtected(path,5,{spawnProcess:()=>child}),closes?/WINDOWS_PROTECTION_FAILED/:/WINDOWS_PROTECTION_CLEANUP_UNCONFIRMED/);
 assert.equal(child.kills,1);assert.equal(child.closed,closes);
});
