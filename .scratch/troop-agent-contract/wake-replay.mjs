// Controlled evidence: real wake store/rearm/revival methods, synthetic services.
// No user profile, provider, actual shell command, or network access.
import {build} from 'esbuild';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp=path.resolve('.tmp-agent-contract');
await mkdir(tmp,{recursive:true});
const fixtureRoot=await mkdtemp(path.join(tmp,'wake-fixture-'));
const runtime=path.join(fixtureRoot,'runtime.cjs');
await build({stdin:{contents:`
export {SandPendingWakeStore} from './source/host/extensions/transcript/sand-pending-wake-store.ts';
export {PendingWakeRearm} from './source/host/extensions/transcript/pending-wake-rearm.ts';
export {CompletionRevivals} from './source/host/extensions/transcript/completion-revivals.ts';
`,resolveDir:process.cwd(),loader:'ts'},outfile:runtime,bundle:true,platform:'node',format:'cjs',target:'node24',packages:'external',logLevel:'warning'});
globalThis.fetch=async()=>{throw new Error('Network disabled in wake replay');};
const {SandPendingWakeStore,PendingWakeRearm,CompletionRevivals}=createRequire(import.meta.url)(runtime);
const results=[];
for(const scenario of ['shell-success','shell-runner-throws','shell-session-unavailable','subagent-runner-throws','execution-disabled']){
  const trace=[];
  const note=(event,data={})=>trace.push({seq:trace.length+1,event,...data});
  const root=path.join(fixtureRoot,scenario);
  const store=new SandPendingWakeStore(root);
  const isSubagent=scenario.startsWith('subagent');
  const agentId='synthetic-parent',workId='synthetic-work',kind=isSubagent?'subagent':'shell';
  let runCount=0;
  const tm={
    pendingWakeStore:store,
    execution:{canExecute:scenario!=='execution-disabled'},
    sessions:{deletedAgentIds:new Set(),isAgentGone:()=>false,async resolveBackgroundSession(id){note('resolve-session',{markerPresent:store.hasPending(agentId,kind,workId)});if(scenario==='shell-session-unavailable')throw new Error('synthetic unavailable');return {id};}},
    telemetry:Object.fromEntries(['reportPendingWake','reportShellRevival','reportSubagentRevival','reportAgentError'].map(name=>[name,data=>note(name,{outcome:data.outcome,reason:data.reason})])),
    roster:{emitAsyncTasksForAgent:id=>note('emit-async-tasks'),emitAgentUpdate:async()=>note('emit-agent-update')},
    runnerRegistry:{getRunner:()=>({async run(){runCount++;note('runner-run',{markerPresent:store.hasPending(agentId,kind,workId)});if(scenario.endsWith('runner-throws'))throw new Error('synthetic runner failure');return {aborted:false,sentMessageCount:0};}})},
    runLifecycle:{beginSessionRun:()=>note('begin-run'),endSessionRun:()=>note('end-run'),enqueueExclusiveRun:async(_id,fn)=>await fn(),lastRequestIdBySession:new Map()},
    turnRuntime:{activeRequestPrompts:new Map(),activeRequestSources:new Map()},
    widgetResponses:{collectUnansweredQuestionPrompts:()=>({})},
    upgradeResume:{markAgentResumePendingForQuiescedRevival:()=>note('upgrade-resume')},
    trayErrors:{pushError:()=>note('tray-error')},
  };
  tm.pendingWakes=new PendingWakeRearm(tm);
  const revivals=new CompletionRevivals(tm);
  assert.equal(tm.pendingWakes.persistPendingWake({parentAgentId:agentId,kind,workId,title:'synthetic',...(isSubagent?{subagentType:'synthetic'}:{})}),true);
  assert.equal(existsSync(store.filePath),true);
  assert.equal(new SandPendingWakeStore(root).hasPending(agentId,kind,workId),true);
  note('marker-reloaded-before-dispatch');
  const queue=isSubagent?revivals.pendingSubagentCompletions:revivals.pendingShellCompletions;
  queue.set(agentId,[isSubagent?{parentAgentId:agentId,subagentAgentId:workId,title:'synthetic',subagentType:'synthetic',status:'success',result:'synthetic completion'}:{agentId,shellId:workId,title:'synthetic',status:'success',detail:'synthetic completion'}]);
  const drain=()=>isSubagent?revivals.reviveForSubagentCompletions(agentId):revivals.reviveForShellCompletions(agentId);
  await drain();
  const attemptsAfterFirstDrain=runCount;
  await drain();
  const remainingMarkerCount=new SandPendingWakeStore(root).listPending().length;
  const remainingQueueCount=queue.get(agentId)?.length??0;
  const retained=scenario==='execution-disabled';
  assert.equal(remainingMarkerCount,retained?1:0);
  assert.equal(remainingQueueCount,retained?1:0);
  assert.equal(runCount,attemptsAfterFirstDrain);
  if(scenario.endsWith('runner-throws')){
    assert.equal(runCount,1);
    assert.ok(trace.some(x=>(x.event==='reportShellRevival'||x.event==='reportSubagentRevival')&&x.outcome==='dropped'&&x.reason==='error'));
    assert.equal(trace.find(x=>x.event==='runner-run').markerPresent,false);
  }
  results.push({scenario,remainingMarkerCount,remainingQueueCount,runnerAttempts:runCount,attemptsOnSecondDrain:runCount-attemptsAfterFirstDrain,markerFileExists:existsSync(store.filePath),trace});
}
const output={
  evidence:'Real reconstructed SandPendingWakeStore, PendingWakeRearm, and CompletionRevivals with synthetic host services and real isolated disk marker files.',
  fixtureRoot:path.relative(process.cwd(),fixtureRoot).replaceAll('\\','/'),
  limitations:['No real model, network, credentials, shell command, or personal profile.', 'Completion entries are injected directly into public in-memory queues; background completion discovery and startup event reconstruction are not exercised.', 'Disk writes/reloads use the real implementation, but no process crash, fsync, power loss, multiprocess races, or external recovery mechanism is tested.', 'Runner and exclusive-run host callbacks are fakes; the result proves this revival path removes its marker/queue before dispatch and does not itself retry these injected failures, not globally permanent information loss.'],
  sourceReferences:['source/host/extensions/transcript/sand-pending-wake-store.ts:111','source/host/extensions/transcript/pending-wake-rearm.ts:56','source/host/extensions/transcript/completion-revivals.ts:128','source/host/extensions/transcript/completion-revivals.ts:240'],
  results,
};
await writeFile(path.resolve('.scratch/troop-agent-contract/wake-results.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(results.map(({trace,...r})=>r),null,2));
