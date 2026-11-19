import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';

test('observer survivor waits share one deadline and still perform scoped cleanup',{skip:process.platform!=='win32'},()=>{
 const dir=mkdtempSync(resolve('work/offline-integration/observer-test-')),native=join(dir,'Fake.cs'),cleanup=join(dir,'cleanup.txt');
 // No process handles or actual termination: the native stand-in models two survivors.
 writeFileSync(native,`using System;using System.IO;using System.Threading;using System.Collections.Generic;
public static class ElyaIndependentObserver {
 static HashSet<long> stopped=new HashSet<long>();
 public static IntPtr Open(uint id){return new IntPtr(id);}
 public static uint WaitForSingleObject(IntPtr h,uint ms){if(stopped.Contains(h.ToInt64()))return 0;if(ms>0)Thread.Sleep((int)ms);return 258;}
 public static uint ExitCode(IntPtr h){return stopped.Contains(h.ToInt64())?31029u:259u;}
 public static void Cleanup(IntPtr h){stopped.Add(h.ToInt64());File.AppendAllText(Environment.GetEnvironmentVariable("ELYA_FAKE_CLEANUP_LOG"),h.ToString()+"\\n");}
 public static bool CloseHandle(IntPtr h){return true;}
}`);
 writeFileSync(join(dir,'members.json'),JSON.stringify([{pid:101,image:'synthetic'},{pid:102,image:'synthetic'}]));
 writeFileSync(join(dir,'owner-action.json'),'{}');
 const win=process.env.SystemRoot??'C:\\Windows',started=performance.now();
 const child=spawnSync(join(win,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-File',resolve('work/offline-integration/observer.ps1'),'-Directory',dir,'-Native',native],{windowsHide:true,encoding:'utf8',timeout:25000,env:{SystemRoot:win,WINDIR:win,PATH:join(win,'System32'),TEMP:dir,TMP:dir,PSModulePath:join(win,'System32','WindowsPowerShell','v1.0','Modules'),ELYA_FAKE_CLEANUP_LOG:cleanup}});
 const elapsed=performance.now()-started;
 assert.equal(child.status,1,child.stderr);assert.ok(existsSync(join(dir,'observer-result.json')),child.stderr);const result=JSON.parse(readFileSync(join(dir,'observer-result.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(result.status,'FAILED');assert.equal(result.error,'SURVIVING_MEMBER');assert.equal(result.cleanupNeeded,true);
 assert.deepEqual(readFileSync(cleanup,'utf8').trim().split(/\r?\n/),['101','102']);
 assert.ok(elapsed<12000,`Survivor wait exceeded the shared 8-second budget plus setup allowance: ${elapsed}ms`);
});
