param([Parameter(Mandatory=$true)][string]$Directory,[Parameter(Mandatory=$true)][string]$Node,[Parameter(Mandatory=$true)][string]$Native,[Parameter(Mandatory=$true)][string]$Worker)
$ErrorActionPreference='Stop'
$report=[ordered]@{supervisorStartedAt=[DateTime]::UtcNow.ToString('o');cleanupStartedAt=$null;terminationRequestedAt=$null;cleanupCompletedAt=$null;cleanupConfirmed=$false;timedOut=$false;error=$null}
$job=$null;$handles=@{}
try{
 $context=Get-Content -LiteralPath (Join-Path $Directory 'context.json') -Raw | ConvertFrom-Json
 Add-Type -Path $Native
 $job=New-Object ElyaProofJob
 if(!$job.ObserverOutside()){throw 'OWNER_NOT_OUTSIDE_JOB'}
 if([DateTime]::UtcNow -ge [DateTime]::Parse($context.deadlineAt).ToUniversalTime()){throw 'DEADLINE_BEFORE_LAUNCH'}
 $job.Start($Node,$Worker,$Directory);$report.rootPid=$job.RootPid
 while($true){
  foreach($memberId in $job.Members()){if(!$handles.ContainsKey([string]$memberId)){$handles[[string]$memberId]=$job.OpenMember($memberId)}}
  if(Test-Path -LiteralPath (Join-Path $Directory 'worker-result.json')){break}
  if([DateTime]::UtcNow -ge [DateTime]::Parse($context.deadlineAt).ToUniversalTime()){$report.timedOut=$true;break}
  Start-Sleep -Milliseconds 50
 }
}catch{$report.error='OWNER_OR_CONTAINMENT_FAILURE'}
finally{
 $report.cleanupStartedAt=[DateTime]::UtcNow.ToString('o')
 if($null -ne $job){
  try{
   $report.terminationRequestedAt=[DateTime]::UtcNow.ToString('o');$job.Kill(31027)
   $wait=[Diagnostics.Stopwatch]::StartNew()
   while(@($job.Members()).Count -gt 0 -and $wait.ElapsedMilliseconds -lt 5000){Start-Sleep -Milliseconds 25}
   $report.remainingMembers=@($job.Members())
   $report.processChecks=@(foreach($entry in $handles.GetEnumerator()){$remaining=[uint32][Math]::Max(0,5000-$wait.ElapsedMilliseconds);[ordered]@{pid=[int]$entry.Key;wait=[ElyaProofJob]::WaitForSingleObject($entry.Value,$remaining);exitCode=$job.ExitCode($entry.Value)}})
   $report.cleanupConfirmed=$report.remainingMembers.Count -eq 0 -and @($report.processChecks | Where-Object {$_.wait -ne 0}).Count -eq 0
   $log=Join-Path $Directory 'rpc.jsonl';$length=if(Test-Path -LiteralPath $log){(Get-Item -LiteralPath $log).Length}else{0}
   Start-Sleep -Milliseconds 1000
   $after=if(Test-Path -LiteralPath $log){(Get-Item -LiteralPath $log).Length}else{0}
   $report.noPostCleanupRpcWrites=$length -eq $after
  }catch{$report.cleanupConfirmed=$false;$report.error='CLEANUP_UNCONFIRMED'}
  finally{$job.Dispose()}
 }
 if($report.cleanupConfirmed -and $report.noPostCleanupRpcWrites){$report.cleanupCompletedAt=[DateTime]::UtcNow.ToString('o')}
 $report.finishedAt=[DateTime]::UtcNow.ToString('o')
 $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Directory 'owner-result.json') -Encoding UTF8
}
if(!$report.cleanupConfirmed -or $report.error){exit 1}
