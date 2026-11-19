import { spawn } from 'node:child_process';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { dirname,join } from 'node:path';

// Static PowerShell program: secret material travels only through anonymous pipes.
// No Key/SecureKey argument: Windows uses user-scoped DPAPI, not custom encryption.
const program=`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; try {
 Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1');
 $v=[Console]::In.ReadToEnd() | ConvertFrom-Json;
 if($v.mode -eq 'protect') { $s=ConvertTo-SecureString -String $v.value -AsPlainText -Force; try { [Console]::Out.Write((ConvertFrom-SecureString -SecureString $s)) } finally { $s.Dispose() } }
 elseif($v.mode -eq 'unprotect') { $s=ConvertTo-SecureString -String $v.value; $p=[IntPtr]::Zero; try { $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)) } finally { if($p -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}; $s.Dispose() } }
 else { exit 2 }
} catch { [Console]::Error.Write('WINDOWS_PROTECTION_FAILED'); exit 2 }`;
function protect(mode,value,ms,spawnProcess=spawn){
 if(process.platform!=='win32'||typeof value!=='string'||value.length>16384||!Number.isFinite(ms)||ms<=0)return Promise.reject(Error('WINDOWS_PROTECTION_UNAVAILABLE'));
 return new Promise((resolve,reject)=>{
  let child,output='',done=false,failed=false,timer,cleanupTimer;
  const finish=(ok,error='WINDOWS_PROTECTION_FAILED')=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(cleanupTimer);ok?resolve(output):reject(Error(error));};
  const abort=()=>{if(done||failed)return;failed=true;clearTimeout(timer);cleanupTimer=setTimeout(()=>finish(false,'WINDOWS_PROTECTION_CLEANUP_UNCONFIRMED'),1000);try{child.kill();}catch{/* No claim of termination without close. */}};
  try{child=spawnProcess(join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',program],{windowsHide:true,stdio:['pipe','pipe','pipe']});
   child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>32768)abort();});
   child.stderr.on('data',()=>{});child.on('error',abort);child.stdin.on('error',abort);child.on('close',code=>finish(!failed&&code===0&&output.length>0));
   timer=setTimeout(abort,Math.min(ms,5000));child.stdin.end(JSON.stringify({mode,value}));
  }catch{if(child)abort();else finish(false);}
 });
}
export async function storeProtected(path,value,ms){const encrypted=await protect('protect',value,ms);if(!/^[a-f0-9]+$/i.test(encrypted))throw Error('WINDOWS_PROTECTION_FAILED');mkdirSync(dirname(path),{recursive:true});try{writeFileSync(path,encrypted,{flag:'wx',mode:0o600});}catch{throw Error('PROTECTED_STORAGE_EXISTS_OR_UNAVAILABLE');}}
export async function readProtected(path,ms,{spawnProcess=spawn}={}){let encrypted;try{encrypted=readFileSync(path,'utf8');}catch{throw Error('PROTECTED_STORAGE_UNAVAILABLE');}return protect('unprotect',encrypted,ms,spawnProcess);}
