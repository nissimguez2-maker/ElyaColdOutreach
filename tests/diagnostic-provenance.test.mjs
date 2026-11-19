import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const api=await import('../src/diagnostic-provenance.mjs').catch(()=>null);
test('launch provenance fingerprints sources, executable and config without copying secret contents',()=>{
 const root=mkdtempSync(join(tmpdir(),'elya-provenance-'));mkdirSync(join(root,'src'));writeFileSync(join(root,'src','fixture.mjs'),'export const x=1;');writeFileSync(join(root,'package.json'),'{}');writeFileSync(join(root,'fake.exe'),'synthetic-binary');writeFileSync(join(root,'config.toml'),'token = "fixture-secret-never-log"');
 const args={root,executables:[{label:'fixture-runtime',path:join(root,'fake.exe')}],configurationFiles:[{label:'local-config',path:join(root,'config.toml')}],settings:{synthetic:true}};
 const first=api.captureLaunchProvenance(args);assert.equal(first.phase,'BEFORE_CONNECTION_WORK');assert.ok(first.capturedAt);assert.ok(!JSON.stringify(first).includes('fixture-secret-never-log'));
 assert.equal(api.captureLaunchProvenance(args).sourceFingerprint,first.sourceFingerprint);writeFileSync(join(root,'src','fixture.mjs'),'export const x=2;');assert.notEqual(api.captureLaunchProvenance(args).sourceFingerprint,first.sourceFingerprint);
 writeFileSync(join(root,'config.toml'),'changed');assert.notEqual(api.captureLaunchProvenance(args).configuration[0].sha256,first.configuration[0].sha256);
});
