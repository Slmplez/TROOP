import fs from 'node:fs';
import { createHash } from 'node:crypto';
const source=process.argv[2];
if(!source)throw Error('Pass the events.jsonl from the explicitly completed manual exercise');
const events=fs.readFileSync(source,'utf8').trim().split(/\r?\n/).map(JSON.parse);
const trace=events.filter(e=>!['startup','notifications'].includes(e.event));
const lockEvents=trace.filter(e=>e.event==='wts_detail'&&e.data.change===7);
const unlockEvents=trace.filter(e=>e.event==='wts_detail'&&e.data.change===8);
const result={date:'2026-11-01',userConfirmedCompleted:true,scope:'Manual Windows lock/unlock in current console session; no active authorized or queued operation in this trace',counts:{locks:lockEvents.length,unlocks:unlockEvents.length,grants:trace.filter(e=>e.event==='task_granted').length,queuedActions:trace.filter(e=>e.event==='queued_action').length,osSubmissions:trace.filter(e=>e.event==='os_submission').length},afterLastUnlock:unlockEvents.at(-1),trace,verdict:'Real WTS notifications observed; observation remained invalid after unlock; no OS input submitted.',notProven:['Cancellation of an already queued action at real lock boundary','Race between final input gate and OS submission','Successful re-observation and new input after unlock','Capture resource restart at lock/unlock']};
const queuedMode=process.argv.includes('--queued');
if(queuedMode){
 const subsequentLock=lockEvents.at(-1);
 const firstQueue=subsequentLock&&trace.findLast(e=>e.ms<=subsequentLock.ms&&e.event==='queued_action'&&e.grant&&e.observed&&e.queued>0&&e.data.delay_ms===60000);
 const discarded=firstQueue&&trace.find(e=>e.ms>=firstQueue.ms&&e.ms<=subsequentLock.ms&&e.data.discarded_count>0);
 const afterDiscard=discarded&&trace.filter(e=>e.ms>=discarded.ms&&e.event==='os_submission');
 result.scope='User-triggered authorized 60-second queued action followed by manual Windows lock/unlock';
 result.queueEvidence={selectedAttempt:'last qualifying queue before last real lock',firstQueue:firstQueue??null,discarded:discarded??null,subsequentLock:subsequentLock??null,osSubmissionsAfterDiscard:afterDiscard?.length??null};
 result.verdict=firstQueue&&discarded&&subsequentLock&&afterDiscard.length===0&&result.afterLastUnlock?.observed===false?'Observed: authorized queued action invalidated, real lock/unlock received, no submission after invalidation. See exact discard event for which gate fired.':'Incomplete: inspect queueEvidence; do not claim queued lock cancellation passed.';
 result.notProven=['Every possible interleaving between final gate and OS submission','Successful re-observation and new input after unlock','Capture resource restart at lock/unlock'];
 const checkpointArg=process.argv.find(a=>a.startsWith('--checkpoint='));
 if(checkpointArg){
  const checkpoint=JSON.parse(fs.readFileSync(checkpointArg.slice('--checkpoint='.length),'utf8'));
  const hash=createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if(checkpoint.traceSha256.toLowerCase()!==hash||!checkpoint.processAlive||checkpoint.elapsedAfterInitialLogReadMs<60000||!firstQueue||!discarded||!subsequentLock||afterDiscard.length!==0||result.afterLastUnlock?.observed!==false)throw Error('Post-deadline checkpoint does not support this trace');
  result.postDeadlineObservation=checkpoint;
  result.verdict+=' Process was still alive more than 60 seconds after the initial post-unlock log read; no old action replay was observed.';
 }
}
fs.writeFileSync('.scratch/troop-windows-control/'+(queuedMode?'queued-lock-results.json':'manual-lock-results.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({counts:result.counts,verdict:result.verdict}));
