import {readFileSync,readdirSync,existsSync} from 'node:fs';import {join} from 'node:path';import {digest,canonical} from './values.mjs';
export function captureLaunchProvenance({root,executables,configurationFiles,settings}){
 const files=['package.json',...readdirSync(join(root,'src')).filter(f=>/\.(mjs|sql)$/.test(f)).map(f=>'src/'+f),
  'package-lock.json','work/connector-compatibility/run.mjs','work/connector-compatibility/worker.mjs','work/connector-compatibility/owner.ps1','work/containment-proof/Job.cs'].sort();
 const fingerprint=(label,path,optional=false)=>{
  if(optional&&!existsSync(path))return {label,present:false};
  try{return {label,present:true,sha256:digest(readFileSync(path))};}catch{throw Error('PROVENANCE_FILE_UNREADABLE');}
 };
 const sources=files.map(file=>fingerprint(file,join(root,file),true));
 return {phase:'BEFORE_CONNECTION_WORK',capturedAt:new Date().toISOString(),nodeVersion:process.version,
  sources,sourceFingerprint:digest(canonical(sources)),
  executables:executables.map(x=>fingerprint(x.label,x.path)),
  configuration:configurationFiles.map(x=>fingerprint(x.label,x.path,true)),
  settingsFingerprint:digest(canonical(settings)),
  dependencyBasis:'Local package manifest/lockfile and executable fingerprints; internal remote connector dependencies unobserved',
  configurationScope:'Known local files only; merged remote configuration and codex_apps registration owner not established',
  credentialsCopied:false};
}
