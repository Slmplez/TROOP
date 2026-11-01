// Evidence collector for this throwaway prototype; reads recorded runs, sends no input.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const dir=path.dirname(fileURLToPath(import.meta.url));
const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
const requireEvidence=(condition,message)=>{if(!condition)throw Error(message);};
const clicks=read('frame-click-results.json');
const recovery=read('capture-recovery-results.json');
const failure=read('recovery-first-failure.json');
requireEvidence(!clicks.error&&!clicks.mappingOnly,'Real click run did not finish successfully');
const clickTrace=clicks.nativeTrace;
const submits=clickTrace.filter(e=>e.event==='os_submission');
const hits=clickTrace.filter(e=>e.event==='target_click_received');
const confirmed=clickTrace.filter(e=>e.event==='frame_click_verified');
requireEvidence(submits.length===2&&hits.length===2&&confirmed.length===2,'Need two submitted and confirmed clicks');
for(let i=0;i<2;i++)requireEvidence(submits[i].data.inserted===3&&submits[i].data.requested===3&&submits[i].ms<=hits[i].ms&&hits[i].ms<=confirmed[i].ms&&submits[i].epoch===hits[i].epoch,'Input/callback ordering mismatch');
requireEvidence(!recovery.error&&recovery.completedAtUtc,'Recovery did not complete');
const t=recovery.nativeTrace;
const lock=t.find(e=>e.event==='wts_detail'&&e.data.change===7);
const unlock=t.find(e=>e.event==='wts_detail'&&e.data.change===8);
const manual=t.find(e=>e.event==='recovery_manual_reobserve');
const fresh=t.find(e=>e.event==='recovery_geometry_ready'&&e.data.after_unlock);
const point=t.find(e=>e.event==='recovery_new_point_received');
const input=t.filter(e=>e.event==='os_submission');
const hit=t.find(e=>e.event==='target_click_received');
const verified=t.find(e=>e.event==='recovery_click_verified');
requireEvidence(lock&&unlock&&manual&&fresh&&point&&hit&&verified&&input.length===1,'Incomplete recovery chain');
requireEvidence(lock.ms<unlock.ms&&unlock.ms<manual.ms&&manual.ms<=fresh.ms&&fresh.ms<point.ms&&point.ms<=input[0].ms&&input[0].ms<=hit.ms&&hit.ms<=verified.ms,'Recovery ordering mismatch');
requireEvidence(!unlock.observed&&unlock.queued===0&&fresh.observed&&fresh.grant,'Unlock/manual observation gate mismatch');
requireEvidence(input[0].epoch===fresh.epoch&&point.epoch===fresh.epoch&&input[0].data.inserted===3&&input[0].data.requested===3,'Fresh epoch/input not proven');
const before=recovery.captures.find(c=>c.label==='before-lock-recreated');
const after=recovery.captures.find(c=>c.label==='after-unlock-new-observation');
requireEvidence(before&&after&&before.trackId!==after.trackId&&after.generation>before.generation,'New stream not proven');
requireEvidence(recovery.release.after.some(track=>track.id===before.trackId&&track.state==='ended'),'Old track release not proven');
requireEvidence(JSON.stringify(before.mapping.geometry.patch_rgb)==='[255,0,255]'&&JSON.stringify(after.mapping.geometry.patch_rgb)==='[0,255,255]'&&after.mapping.patch.count>=400,'Fresh color frame not proven');
requireEvidence(after.mapping.geometry.epoch===fresh.epoch,'Frame observation epoch mismatch');
const files=['src/main.rs','electron-capture.cjs','frame-click-results.json','capture-recovery-results.json','recovery-first-failure.json'];
const summary={
 date:'2026-11-01',timeZone:'Asia/Shanghai',scope:'Own synthetic HWND; current local console only',
 frameClick:{verifiedClicks:confirmed.length,osInsertedEvents:submits.reduce((n,e)=>n+e.data.inserted,0),maxMappingErrorPhysicalPixels:Math.max(...clicks.captures.filter(c=>c.mapping).flatMap(c=>c.mapping.error.map(Math.abs))),source:'frame-click-results.json'},
 recovery:{locks:1,unlocks:1,oldTrackStateWhenReleaseRequested:recovery.release.before[0].state,oldTrackStateAfterRelease:recovery.release.after[0].state,newStreamGeneration:after.generation,newObservationEpoch:fresh.epoch,osSubmissionsBeforeManualObservation:input.filter(e=>e.ms<manual.ms).length,newClicksAfterObservation:1,manualObservationToSubmissionMs:input[0].ms-manual.ms,source:'capture-recovery-results.json'},
 failedAttempt:{source:'recovery-first-failure.json',error:failure.error,lockObserved:failure.nativeTrace?.some(e=>e.event==='wts_detail'&&e.data.change===7),resolution:'Renamed prototype event buffer from the existing Window.captureEvents member to troopCaptureEvents; added release/recreate preflight before asking for a real lock.'},
 hardware:{displays:recovery.displays,nativeMonitorCount:t[0].data.monitor_count,targetDpi:t[0].data.dpi,multiMonitorMixedDpi:'deferred_pending_hardware',userDecision:'暂时没有，记录为待硬件验证',systemDisplaySettingsChanged:false},
 notProven:['Mixed DPI and multiple physical monitors','Negative monitor coordinates, hotplug and display rotation','All final-gate/SendInput races','Native Rust WGC backend','Independent input-helper fault isolation','UIPI elevated targets, RDP and UIA fallback'],
 sha256:Object.fromEntries(files.map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(dir,name))).digest('hex')]))
};
fs.writeFileSync(path.join(dir,'third-pass-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({frameClick:summary.frameClick,recovery:summary.recovery,hardware:summary.hardware}));
