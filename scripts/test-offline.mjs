// Portable, explicitly selected synthetic tests. No production import or setup.
import {readFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(readFileSync(new URL('../tests/offline-suite.json',import.meta.url),'utf8'));
if(process.argv.length!==2)throw Error('No arbitrary commands or live options accepted');
const preload=new URL('../tests/helpers/deny-network-preload.mjs',import.meta.url).href;
// Empty scratch parents required by two existing isolation/containment tests.
for(const path of ['work/local-integrations-v1','work/readiness'])mkdirSync(new URL('../'+path+'/',import.meta.url),{recursive:true});
console.log(`Portable synthetic suite: ${manifest.included.length} files; ${manifest.excluded.length} private-evidence or historical files excluded explicitly. See tests/offline-suite.json.`);
// Do not inherit arbitrary Node preloads. This guard also reaches Node children.
const result=spawnSync(process.execPath,['--test','--test-concurrency=4','--test-reporter=tap',...manifest.included],{cwd:root,env:{...process.env,NODE_OPTIONS:`--import=${preload}`},windowsHide:true,stdio:'inherit',timeout:180000});
if(result.error)console.error(result.error.code??'OFFLINE_TEST_LAUNCH_FAILED');
process.exitCode=result.status??1;
