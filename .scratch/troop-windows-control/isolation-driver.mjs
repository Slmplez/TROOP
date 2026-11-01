// Bounded fault drill, not a production coordinator. Each scenario owns fresh processes.
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';
const root=process.argv[2],selection=process.argv[3]||'all';
const output=fs.mkdtempSync(path.join(root,'.tmp-host-control/isolation-'));
fs.writeFileSync(path.join(root,'.tmp-host-control/latest-isolation-run.json'),JSON.stringify({directory:output}));
const helperExe=path.join(root,'.tmp-host-control/build/debug/control-helper.exe');
const captureExe=path.join(root,'.tmp-host-control/electron-shell/troop-capture-prototype.exe');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const requireEvidence=(v,m)=>{if(!v)throw Error(m);};
const report={date:'2026-11-01',scope:'Own synthetic target; separate Rust input helper and Electron capture process',scenarios:[]};
report.sourceHashes=Object.fromEntries(['Cargo.toml','Cargo.lock','src/isolation_common.rs','src/bin/control-helper.rs','src/bin/isolation-target.rs','src/bin/permission-probe.rs','isolation-capture.cjs','isolation-driver.mjs','run-isolation.ps1'].map(p=>[p,createHash('sha256').update(fs.readFileSync(path.join(root,'.scratch/troop-windows-control',p))).digest('hex')]));
report.hashScope='Local source bytes at run start; Git may normalize line endings.';
const save=()=>fs.writeFileSync(path.join(output,'isolation-results.json'),JSON.stringify(report,null,2)+'\n');
async function run(name){
 const dir=path.join(output,name);fs.mkdirSync(dir);const trace=[];
 const result={name,trace};report.scenarios.push(result);save();
 const helper=spawn(helperExe,name==='partial-result'?['--inject-partial-result']:[],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let buffer='';helper.stdout.on('data',b=>{buffer+=b;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);if(line.trim()){const e=JSON.parse(line);if(e.event==='diagnostic_filler'){result.fillerEventsReceived=(result.fillerEventsReceived||0)+1;continue;}trace.push(e);fs.appendFileSync(path.join(dir,'helper-events.jsonl'),line+'\n');}}});
 let helperError='';helper.stderr.on('data',b=>helperError+=b.toString());helper.stdin.on('error',()=>{});
 let capture;let capturedError='';let heartbeat;let sessionTimer;let sessionSampler;
 const wait=async(predicate,label,timeout=12000)=>{const end=Date.now()+timeout;const from=trace.length;while(Date.now()<end){const value=predicate();if(value)return value;if(helper.exitCode!==null)throw Error('Helper exited: '+helperError);if(label.includes('observation')){const rejected=trace.slice(from).find(e=>e.event==='command_denied'&&e.data.op==='observe');if(rejected){result.blockedPrerequisite=rejected.data;throw Error('Observation unavailable: '+JSON.stringify(rejected.data));}}await sleep(20);}throw Error('Timed out: '+label);};
 const command=value=>helper.stdin.write(JSON.stringify(value)+'\n');
 try{
  const ready=(await wait(()=>trace.find(e=>e.event==='helper_ready'),'helper ready')).data;
  result.helperPid=helper.pid;result.targetPid=ready.target.pid;result.identity=ready;
  heartbeat=setInterval(()=>{if(helper.stdin.writable&&!helper.stdin.destroyed)command({op:'heartbeat'});},100);
  fs.writeFileSync(path.join(dir,'target.json'),JSON.stringify(ready.target));
  if(name==='capture-lifecycle'||name==='capture-soak'){
   result.scope='Capture lifecycle only; no task grant, observation or input';
   capture=spawn(captureExe,[],{cwd:root,windowsHide:true,env:{...process.env,TROOP_ISOLATION_DIR:dir},stdio:['ignore','ignore','pipe']});capture.stderr.on('data',b=>capturedError+=b.toString());result.capturePid=capture.pid;
   result.initialFrame=await wait(()=>{const f=path.join(dir,'capture-ready.json');return fs.existsSync(f)&&JSON.parse(fs.readFileSync(f,'utf8'));},'initial capture',15000);
   const snapshot=async(id,restart=false)=>{fs.writeFileSync(path.join(dir,'capture-fault.json'),JSON.stringify({mode:'snapshot',id,restart}));const end=Date.now()+12000;while(Date.now()<end){const f=path.join(dir,`snapshot-${id}.json`);if(fs.existsSync(f))return JSON.parse(fs.readFileSync(f,'utf8'));await sleep(20);}throw Error('Lifecycle snapshot timeout: '+id);};
   if(name==='capture-soak'){
    command({op:'fixture-animate'});await wait(()=>trace.find(e=>e.event==='target_event'&&e.data.event==='target_animation_started'),'changing own fixture');
    result.soakSamples=[];result.soakStartUtcMs=Date.now();
    for(let i=0;i<24;i++){await sleep(5000);const sample=await snapshot('soak-'+i);result.soakSamples.push({utc_ms:Date.now(),...sample});save();requireEvidence(sample.newFrame&&sample.magenta>=400&&sample.frameMetadata,'Missing sampled frame during soak');if(i>0)requireEvidence(sample.frameMetadata.presentedFrames>result.soakSamples[i-1].frameMetadata.presentedFrames,'Frame counter did not advance');}
    result.soakElapsedMs=Date.now()-result.soakStartUtcMs;
   }
   command({op:'fixture-minimize'});await wait(()=>trace.find(e=>e.event==='target_event'&&e.data.event==='target_minimized'),'fixture minimizes');await sleep(200);result.minimized=await snapshot('minimized');
   command({op:'fixture-restore-change'});const restored=await wait(()=>trace.find(e=>e.event==='target_event'&&e.data.event==='target_restored_changed'),'fixture restore');result.restoreEvent=restored.data.data;requireEvidence(!result.restoreEvent.iconic,'Target not restored');await sleep(300);result.restoredOldStream=await snapshot('restored');result.recreatedStream=await snapshot('recreated',true);
   requireEvidence(result.recreatedStream.newFrame&&result.recreatedStream.cyan>=400&&result.recreatedStream.magenta===0,'Changed fresh frame not proven after recreation');requireEvidence(result.recreatedStream.oldState.every(s=>s==='ended'),'Old stream not ended before recreation');
   process.kill(ready.target.pid);await sleep(300);result.afterTargetClose=await snapshot('closed');requireEvidence(!result.afterTargetClose.targetEnumerated&&result.afterTargetClose.trackStates.every(s=>s==='ended'),'Closed target capture was not ended/unavailable');
   requireEvidence(!trace.some(e=>e.event==='os_submission'||e.event==='granted'),'Capture-only fixture sent input or granted control');
   result.captureTrace=fs.readFileSync(path.join(dir,'capture-events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);result.passed=true;return;
  }
  const point=[ready.target.marker_rect[0]+26,ready.target.marker_rect[1]+26];
  command({op:'enqueue',epoch:ready.epoch,target_pid:ready.target.pid,point,delay_ms:0});
  await wait(()=>trace.find(e=>e.event==='command_denied'&&e.data.reason==='not_authorized'),'unauthorized denial');
  command({op:'grant'});await wait(()=>trace.find(e=>e.event==='granted'),'grant');
  if(name==='stop-transport'){
   result.scope='Independent stop acknowledgment under log backpressure, WITHOUT observation, pending action or OS input';
   helper.stdout.pause();command({op:'diagnostic-fill-output'});await sleep(350);
   const signal=spawn(helperExe,['--signal-stop',ready.stop_event,ready.stop_ack_event],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let data='';signal.stdout.on('data',b=>data+=b);
   const code=await new Promise(resolve=>signal.once('exit',resolve));result.signal=JSON.parse(data.trim());requireEvidence(code===0&&result.signal.data.kernel_ack,'Kernel stop ACK unavailable while logs blocked');
   helper.stdout.resume();await sleep(250);command({op:'status'});result.finalState=(await wait(()=>trace.find(e=>e.event==='status'),'stopped state')).data;
   requireEvidence(result.finalState.stopped&&!result.finalState.grant&&!result.finalState.pending&&result.finalState.diagnostic_events_dropped>0,'Stopped state or actual backpressure not proven');
   command({op:'grant'});await wait(()=>trace.find(e=>e.event==='command_denied'&&e.data.reason==='stopped_requires_new_run'),'grant remains revoked');
   requireEvidence(!trace.some(e=>e.event==='os_submission'),'Unexpected OS input');result.passed=true;return;
  }
  // Initial preparation only: give the operator time to activate the owned fixture.
  // Later focus loss still invalidates the observation; no queued action is retried.
  console.log(JSON.stringify({name,phase:'waiting_for_initial_foreground',targetPid:ready.target.pid}));
  let observation;const preparationEnd=Date.now()+60000;
  while(Date.now()<preparationEnd){
   const start=trace.length;command({op:'observe'});
   const reply=await wait(()=>trace.slice(start).find(e=>e.event==='observed'||(e.event==='command_denied'&&e.data.op==='observe')),'initial preparation response');
   if(reply.event==='observed'){observation=reply.data;break;}
   if(reply.data.detail!=='target_not_foreground'){result.blockedPrerequisite=reply.data;throw Error('Initial preparation refused: '+JSON.stringify(reply.data));}
   await sleep(400);
  }
  if(!observation){result.blockedPrerequisite={reason:'initial_foreground_timeout',waitMs:60000};throw Error('Own target did not become foreground within initial preparation window');}
  command({op:'enqueue',epoch:observation.epoch-1,target_pid:ready.target.pid,point,delay_ms:0});
  command({op:'enqueue',epoch:observation.epoch,target_pid:ready.target.pid+1,point,delay_ms:0});
  await wait(()=>trace.find(e=>e.event==='command_denied'&&e.data.reason==='target_identity'),'target mismatch denial');
  if(name==='permission'){
   const permissionExe=path.join(root,'.tmp-host-control/build/debug/permission-probe.exe');
   const permissionRun=async(diagnostic)=>{
    const child=spawn(permissionExe,[String(ready.target.hwnd),String(ready.target.pid),dir,...(diagnostic?['--diagnostic']:[])],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let data='',error='';child.stdout.on('data',b=>data+=b);child.stderr.on('data',b=>error+=b);
    const exit=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Permission probe timed out'));},15000);child.once('error',reject);child.once('exit',c=>{clearTimeout(timer);resolve(c);});});
    requireEvidence(exit===0,'Permission process failed: '+data+error);return {exit,stdout:data,stderr:error};
   };
   result.permission=await permissionRun(false);
   const p=JSON.parse(fs.readFileSync(path.join(dir,'permission-child.json'),'utf8'));result.permission.child=p;
   requireEvidence(p.policyDenied&&p.senderIntegrity<p.targetIntegrity,'Actual integrity comparison missing');
   requireEvidence(p.senderUiAccess===0&&!p.diagnosticCallAttempted&&p.policyPathOsCalls===0,'Policy path must not submit OS input');
   await sleep(250);result.permission.policyTargetHits=trace.filter(e=>e.event==='target_event'&&e.data.event==='target_hit').length;
   requireEvidence(result.permission.policyTargetHits===0,'Policy refusal unexpectedly hit target');
   result.permission.diagnosticProcess=await permissionRun(true);
   const diagnostic=JSON.parse(fs.readFileSync(path.join(dir,'permission-diagnostic.json'),'utf8'));
   await sleep(500);result.permission.diagnostic={...diagnostic,targetHits:trace.filter(e=>e.event==='target_event'&&e.data.event==='target_hit').length,verdict:'Diagnostic only: preserve OS return and target delivery separately; do not infer UIPI solely from return code.'};
   const previous=trace.length;command({op:'observe'});observation=(await wait(()=>trace.slice(previous).find(e=>e.event==='observed'),'same-target positive observation')).data;
   command({op:'enqueue',epoch:observation.epoch,target_pid:ready.target.pid,point,delay_ms:0});
   await wait(()=>trace.slice(previous).find(e=>e.event==='target_event'&&e.data.event==='target_hit'),'same-target medium-integrity positive control');
   result.permission.sameTargetPositiveControl=true;
  }else{
   capture=spawn(captureExe,[],{cwd:root,windowsHide:true,env:{...process.env,TROOP_ISOLATION_DIR:dir},stdio:['ignore','ignore','pipe']});capture.stderr.on('data',b=>capturedError+=b.toString());result.capturePid=capture.pid;
   const frame=await wait(()=>{const f=path.join(dir,'capture-ready.json');return fs.existsSync(f)&&JSON.parse(fs.readFileSync(f,'utf8'));},'real capture',15000);
   result.captureFrame=frame;
   // Re-observe immediately after capture; all coordinate and focus gates remain active.
   const previous=trace.length;command({op:'observe'});observation=(await wait(()=>trace.slice(previous).find(e=>e.event==='observed'),'fresh observation')).data;
   if(name==='stale-observation')await sleep(5200);
   const uiStop=['hotkey-stop','button-stop'].includes(name);
   command({op:'enqueue',epoch:observation.epoch,target_pid:ready.target.pid,point:frame.point,delay_ms:['normal','stale-observation','partial-result'].includes(name)?0:(uiStop||name==='manual-lock')?60000:1500});
   await wait(()=>trace.find(e=>e.event==='queued'),'queued action');
   if(name==='manual-lock'){
    result.sessionSamples=[];let sampling=false;
    sessionTimer=setInterval(async()=>{if(sampling)return;sampling=true;try{
     sessionSampler=spawn(helperExe,['--environment-snapshot'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let data='';sessionSampler.stdout.on('data',b=>data+=b);const code=await new Promise(resolve=>sessionSampler.once('exit',resolve));if(code===0)result.sessionSamples.push(JSON.parse(data.trim()));
    }finally{sampling=false;}},300);
    result.manualPhase='ready_for_human_lock';save();console.log('Manual lock ready: '+dir);
    const unavailable=await wait(()=>result.sessionSamples.find(e=>!e.data.active_default_unlocked_local_session),'actual session unavailable',90000);
    result.sessionUnavailableUtcMs=unavailable.utc_ms;
    await wait(()=>trace.find(e=>e.event==='observation_invalidated'&&e.data.discarded),'old queue invalidation');
    result.manualPhase='waiting_for_human_unlock';save();
    const available=await wait(()=>result.sessionSamples.find(e=>e.utc_ms>unavailable.utc_ms&&e.data.active_default_unlocked_local_session),'actual session available',90000);result.sessionAvailableUtcMs=available.utc_ms;
    await sleep(Math.max(0,trace.find(e=>e.event==='queued').utc_ms+60500-Date.now()));
    requireEvidence(!trace.some(e=>e.event==='os_submission'),'Old input replayed across lock/unlock');result.noInputBeyondOriginalDeadline=true;
    result.manualPhase='waiting_for_explicit_resume';save();
    const resumePath=path.join(dir,'human-resume.json');await wait(()=>fs.existsSync(resumePath),'explicit human resume token',90000);result.humanResume=JSON.parse(fs.readFileSync(resumePath,'utf8'));requireEvidence(result.humanResume.confirmed===true&&result.humanResume.utc_ms>=available.utc_ms,'Resume confirmation predates unlock');
    const before=trace.length;command({op:'fixture-restore-change'});await wait(()=>trace.slice(before).find(e=>e.event==='target_event'&&e.data.event==='target_restored_changed'),'changed recovery fixture');
    fs.writeFileSync(path.join(dir,'capture-fault.json'),JSON.stringify({mode:'snapshot',id:'lock-recovery',restart:true}));
    result.recoveryFrame=await wait(()=>{const f=path.join(dir,'snapshot-lock-recovery.json');return fs.existsSync(f)&&JSON.parse(fs.readFileSync(f,'utf8'));},'capture recovery after human resume',15000);
    requireEvidence(result.recoveryFrame.newFrame&&result.recoveryFrame.cyan>=400&&result.recoveryFrame.magenta===0&&result.recoveryFrame.oldState?.every(s=>s==='ended'),'Fresh changed capture not proven');
    const observedAt=trace.length;command({op:'observe'});const fresh=(await wait(()=>trace.slice(observedAt).find(e=>e.event==='observed'),'manual fresh observation')).data;
    result.resumedInputPointSource='Fresh native observation; image color is a freshness prerequisite, not a new image-coordinate mapping sample';
    command({op:'enqueue',epoch:fresh.epoch,target_pid:ready.target.pid,point:fresh.point,delay_ms:0});await wait(()=>trace.slice(observedAt).find(e=>e.event==='target_event'&&e.data.event==='target_hit'),'new explicit post-unlock action');
    result.manualPhase='completed';result.newActionAfterExplicitResume=true;
   }else if(name==='partial-result'){
    result.scope='Fault-injected partial return, after real gates; SendInput deliberately NOT called';
    await wait(()=>trace.find(e=>e.event==='indeterminate'&&e.data.no_retry),'indeterminate result');
    command({op:'status'});result.finalState=(await wait(()=>trace.find(e=>e.event==='status'),'stopped state')).data;
    requireEvidence(result.finalState.stopped&&!result.finalState.grant&&!result.finalState.pending,'Partial result failed to revoke');
    const signal=spawn(helperExe,['--signal-stop',ready.stop_event,ready.stop_ack_event],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let data='';signal.stdout.on('data',b=>data+=b);const code=await new Promise(resolve=>signal.once('exit',resolve));result.signal=JSON.parse(data.trim());requireEvidence(code===0&&result.signal.data.kernel_ack,'Partial-result state lacks independent ACK');
    command({op:'grant'});await wait(()=>trace.find(e=>e.event==='command_denied'&&e.data.reason==='stopped_requires_new_run'),'no implicit retry grant');await sleep(250);
    requireEvidence(trace.filter(e=>e.event==='simulated_os_result').length===1&&!trace.some(e=>e.event==='os_submission'||(e.event==='target_event'&&e.data.event==='target_hit')),'Unexpected real input/retry during injected partial result');
   }else if(name==='normal'){
    await wait(()=>trace.find(e=>e.event==='target_event'&&e.data.event==='target_hit'),'actual target callback');
    requireEvidence(trace.some(e=>e.event==='os_submission'&&e.data.inserted===3),'Input submission missing');
   }else if(name==='stale-observation'){
    await wait(()=>trace.find(e=>e.event==='dispatch_denied'&&e.data.reason==='observation_expired'),'expired observation denial');
    requireEvidence(!trace.some(e=>e.event==='os_submission'),'Expired observation submitted input');
   }else if(name==='focus-pulse'){
    command({op:'exercise-focus-loss'});
    const invalid=await wait(()=>trace.find(e=>e.event==='observation_invalidated'&&e.data.discarded),'focus invalidation');
    const returned=await wait(()=>trace.find(e=>e.event==='target_event'&&e.data.event==='focus_pulse_returned'),'focus returns');
    requireEvidence(returned.data.data.target_foreground,'Fixture did not regain its own foreground');
    await sleep(1700);requireEvidence(!trace.some(e=>e.event==='os_submission'),'Old action replayed after focus returned');
    result.noReplayAfterFocusReturn=true;result.invalidatedEpoch=invalid.data.epoch;
    const freshStart=trace.length;command({op:'observe'});const fresh=(await wait(()=>trace.slice(freshStart).find(e=>e.event==='observed'),'explicit fresh observation')).data;
    command({op:'enqueue',epoch:fresh.epoch,target_pid:ready.target.pid,point:frame.point,delay_ms:0});
    await wait(()=>trace.slice(freshStart).find(e=>e.event==='target_event'&&e.data.event==='target_hit'),'new action after explicit observation');result.newActionAfterExplicitObservation=true;
   }else if(name==='output-backpressure'){
    helper.stdout.pause();command({op:'diagnostic-fill-output'});await sleep(350);
    const signal=spawn(helperExe,['--signal-stop',ready.stop_event,ready.stop_ack_event],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let signalText='';signal.stdout.on('data',b=>signalText+=b);
    await new Promise((resolve,reject)=>{signal.once('exit',c=>c===0?resolve():reject(Error('Independent kernel ACK failed under log backpressure')));});result.signal=JSON.parse(signalText.trim());requireEvidence(result.signal.data.kernel_ack,'Missing kernel stop acknowledgment');
    await sleep(1900);result.observedBeyondOriginalDeadline=true;
    const probe=spawn(helperExe,['--read-owned-target-hits',String(ready.target.hwnd),String(ready.target.pid)],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let counter='';probe.stdout.on('data',b=>counter+=b);const code=await new Promise(resolve=>probe.once('exit',resolve));requireEvidence(code===0,'Target counter could not be read');result.independentTargetCounter=JSON.parse(counter.trim());requireEvidence(result.independentTargetCounter.data.hits===0,'Target received input while logs blocked');
    helper.stdout.resume();await sleep(250);command({op:'status'});const status=(await wait(()=>trace.find(e=>e.event==='status'),'state after output resumes')).data;
    result.stateAfterOutputResumes=status;requireEvidence(status.stopped&&!status.grant&&!status.pending&&status.diagnostic_events_dropped>0,'Backpressure or cleared state not proven');
   }else if(name==='helper-crash'){
    result.helperKillUtcMs=Date.now();helper.kill();await sleep(300);
    const check=spawn(helperExe,['--wait-owned-target-exit',String(ready.target.pid)],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let data='';check.stdout.on('data',b=>data+=b);
    const code=await new Promise(resolve=>check.once('exit',resolve));result.targetExitAfterHelperCrash={code,report:JSON.parse(data.trim())};requireEvidence(code===0,'Target survived helper crash despite job fencing');
    await sleep(1600);requireEvidence(!trace.some(e=>e.event==='os_submission'),'Input preceded crash cancellation');result.observedBeyondOriginalDeadline=true;
   }else{
    if(uiStop){
     fs.writeFileSync(path.join(dir,'capture-fault.json'),JSON.stringify({mode:'hang'}));
     await wait(()=>fs.readFileSync(path.join(dir,'capture-events.jsonl'),'utf8').includes('capture_hang_injected'),'capture blocked before UI stop');
     result.uiStopWaitingUtcMs=Date.now();save();console.log('Waiting for '+name+' in own target window');
    }else if(name==='channel-eof'){
     result.stopRequestUtcMs=Date.now();clearInterval(heartbeat);helper.stdin.end();
    }else if(name==='lease-timeout'){
     result.stopRequestUtcMs=Date.now();clearInterval(heartbeat);
    }else if(name==='target-crash'){
     result.stopRequestUtcMs=Date.now();process.kill(ready.target.pid);
    }else{
     fs.writeFileSync(path.join(dir,'capture-fault.json'),JSON.stringify({mode:name==='capture-hang'?'hang':'exit'}));
     await wait(()=>fs.existsSync(path.join(dir,'capture-events.jsonl'))&&fs.readFileSync(path.join(dir,'capture-events.jsonl'),'utf8').includes(name==='capture-hang'?'capture_hang_injected':'capture_exit_injected'),'fault reached');
     if(name==='capture-exit')await wait(()=>capture.exitCode===73,'capture process exit');
     else{await sleep(250);result.captureAliveAtStop=capture.exitCode===null;requireEvidence(result.captureAliveAtStop,'Hang process must still be alive');}
     result.stopRequestUtcMs=Date.now();
     const signal=spawn(helperExe,['--signal-stop',ready.stop_event,ready.stop_ack_event],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let signalText='';signal.stdout.on('data',b=>signalText+=b);
     await new Promise((resolve,reject)=>{signal.once('exit',c=>c===0?resolve():reject(Error('Stop signal failed')));signal.once('error',reject);});result.signal=JSON.parse(signalText.trim());
    }
    const ack=await wait(()=>trace.find(e=>e.event==='stop_ack'),'stop acknowledgment',uiStop?55000:12000);
    result.stopAckUtcMs=ack.utc_ms;if(!uiStop)result.stopLatencyIncludingSignalProcessMs=ack.utc_ms-result.stopRequestUtcMs;
    requireEvidence((ack.data.discarded||trace.some(e=>e.event==='observation_invalidated'&&e.data.discarded))&&ack.data.grant===false,'Stop did not revoke and clear queued action');
    if(!['channel-eof','target-crash'].includes(name)){command({op:'grant'});command({op:'enqueue',epoch:observation.epoch,target_pid:ready.target.pid,point:frame.point,delay_ms:0});await wait(()=>trace.find(e=>e.event==='command_denied'&&e.data.reason==='stopped_requires_new_run'),'post-stop denial');}
    await sleep(uiStop?Math.max(0,trace.find(e=>e.event==='queued').utc_ms+60500-Date.now()):1900);
    requireEvidence(!trace.some(e=>e.event==='os_submission'),'Input appeared after fault/stop');
    requireEvidence(!trace.some(e=>e.event==='target_event'&&e.data.event==='target_hit'),'Target callback appeared after fault/stop');
    result.observedBeyondOriginalDeadline=true;
   }
   result.captureTrace=fs.readFileSync(path.join(dir,'capture-events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
  }
  result.passed=true;
 }catch(e){result.passed=false;result.error=String(e);}
 finally{
  clearInterval(heartbeat);clearInterval(sessionTimer);if(sessionSampler&&sessionSampler.exitCode===null)sessionSampler.kill();
  helper.stdout.resume();
  if(helper.stdin.writable&&!helper.stdin.destroyed)command({op:'exit'});
  await sleep(100);if(helper.exitCode===null)helper.kill();
  if(capture&&capture.exitCode===null){
   // Windows taskkill /T is scoped to this exact owned process, also removes its Electron children.
   await new Promise(resolve=>{const kill=spawn('taskkill.exe',['/PID',String(capture.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});kill.once('exit',resolve);});
  }
  result.helperStderr=helperError;result.captureStderr=capturedError;save();
 }
 console.log(JSON.stringify({name,passed:result.passed,error:result.error,stopLatencyMs:result.stopLatencyIncludingSignalProcessMs}));
}
for(const scenario of selection==='all'?['normal','focus-pulse','stale-observation','capture-hang','capture-exit','channel-eof','lease-timeout','helper-crash','target-crash','output-backpressure','permission','partial-result']:[selection]){await run(scenario);if(report.scenarios.at(-1).blockedPrerequisite)break;}
console.log('Evidence: '+output);if(report.scenarios.some(s=>!s.passed))process.exitCode=1;
