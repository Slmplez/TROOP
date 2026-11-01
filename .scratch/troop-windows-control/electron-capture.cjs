// THROWAWAY capture comparison. No old application code is loaded.
const {app, BrowserWindow, desktopCapturer, screen} = require('electron');
const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
const root=process.env.TROOP_PROTOTYPE_ROOT;
if(!root)throw Error('Run via run-capture.ps1');
const frameProbe=process.env.TROOP_FRAME_PROBE==='1';
const mappingOnly=process.env.TROOP_MAPPING_ONLY==='1';
const recoveryProbe=process.env.TROOP_RECOVERY_PROBE==='1';
const out=(frameProbe||recoveryProbe)?fs.mkdtempSync(path.join(root,recoveryProbe?'.tmp-host-control/recovery-capture-':'.tmp-host-control/frame-capture-')):path.join(root,'.tmp-host-control/electron-target-capture');fs.mkdirSync(out,{recursive:true});
if(frameProbe||recoveryProbe)fs.writeFileSync(path.join(root,recoveryProbe?'.tmp-host-control/latest-recovery-run.json':'.tmp-host-control/latest-frame-run.json'),JSON.stringify({directory:out}));
app.setPath('userData',path.join(out,'profile'));
if(process.env.TROOP_CAPTURE_SOFTWARE==='1')app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
let child;let panel;let result;
function save(){if(result)fs.writeFileSync(path.join(out,'capture-results.json'),JSON.stringify(result,null,2)+'\n');}
process.on('uncaughtException',e=>{if(result){result.fatal=String(e);save();}app.quit();});
process.on('unhandledRejection',e=>{if(result){result.fatal=String(e);save();}app.quit();});
app.whenReady().then(async()=>{
 result={electron:process.versions.electron,chrome:process.versions.chrome,scope:'Zero-thumbnail enumeration followed by media capture of exact own synthetic HWND',hardwareAcceleration:app.isHardwareAccelerationEnabled(),displays:screen.getAllDisplays().map(d=>({bounds:d.bounds,scaleFactor:d.scaleFactor,rotation:d.rotation})),captures:[],stage:'ready'};save();
 result.recoveryProbe=recoveryProbe;
 result.displayChanges=[];
 for(const name of ['display-added','display-removed','display-metrics-changed'])screen.on(name,(_event,d,metrics)=>{result.displayChanges.push({event:name,atUtc:new Date().toISOString(),bounds:d.bounds,scaleFactor:d.scaleFactor,metrics});save();});
 panel=new BrowserWindow({title:'TROOP 捕获对照 — 专用测试窗',width:960,height:780,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 panel.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 const panelPath=path.join(out,'panel.html');fs.writeFileSync(panelPath,'<meta charset="utf-8"><h2>TROOP 专用窗口捕获对照</h2><p id="status">请在原生测试窗开始演练；这里只捕获该测试窗。</p><video muted autoplay style="max-width:100%"></video>');await panel.loadFile(panelPath);
 const childOut=path.join(out,'native');
 child=spawn(path.join(root,'.tmp-host-control/build/debug/troop-host-control-prototype.exe'),[childOut,...(frameProbe?['--frame-probe']:[]),...(mappingOnly?['--mapping-only']:[]),...(recoveryProbe?['--recovery-probe']:[])],{cwd:root,windowsHide:false,stdio:['ignore','ignore','pipe']});
 result.mappingOnly=mappingOnly;
 result.stage='native-started';save();
 let childError='';child.stderr.on('data',b=>childError+=b.toString());
 let exit;child.once('exit',(code,signal)=>{exit={code,signal};});
 async function sample(label,geometry,{keepStream=false,sendInput=true}={}){
  const file=path.join(childOut,'events.jsonl');if(!fs.existsSync(file)){result.captures.push({label,error:'native did not produce identity'});return;}
  const startup=JSON.parse(fs.readFileSync(file,'utf8').split('\n')[0]);const hwnd=String(startup.data.hwnd);
  result.stage='enumerating-'+label;save();
  let timer;const sources=await Promise.race([desktopCapturer.getSources({types:['window'],thumbnailSize:{width:0,height:0},fetchWindowIcons:false}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('enumeration timeout after 10 seconds')),10000)})]).finally(()=>clearTimeout(timer));
  const target=sources.filter(s=>s.id.split(':')[1]===hwnd&&s.name==='TROOP 宿主控制原型 — 仅专用测试窗口');
  if(target.length!==1){result.captures.push({label,targetFound:false,ownTitleCandidates:sources.filter(s=>s.name==='TROOP 宿主控制原型 — 仅专用测试窗口').map(s=>s.id)});return;}
  result.stage='media-'+label;save();
  const frame=await renderer(`(async()=>{
   let stream;let timer;
   try{stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:${JSON.stringify(target[0].id)}}}});
    window.heldCapture=stream;window.captureGeneration=(window.captureGeneration||0)+1;
    const track=stream.getVideoTracks()[0];window.troopCaptureEvents=window.troopCaptureEvents||[];
    for(const name of ['ended','mute','unmute'])track.addEventListener(name,()=>window.troopCaptureEvents.push({event:name,generation:window.captureGeneration,atUtc:new Date().toISOString()}));
    const video=document.querySelector('video');video.srcObject=stream;await video.play();
    await Promise.race([new Promise(resolve=>video.requestVideoFrameCallback(resolve)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('video frame timeout')),8000)})]);
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);
    const rgba=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let minX=canvas.width,minY=canvas.height,maxX=-1,maxY=-1,count=0;
    const rgb=${JSON.stringify(geometry?.patch_rgb||[255,0,255])};
    for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){const i=(y*canvas.width+x)*4;if(rgb.every((v,c)=>Math.abs(rgba[i+c]-v)<50)){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);count++;}}
    return {width:canvas.width,height:canvas.height,png:canvas.toDataURL('image/png'),patch:count?{minX,minY,maxX,maxY,count}:null,generation:window.captureGeneration,trackId:track.id,trackState:track.readyState,atUtc:new Date().toISOString()};
   }finally{clearTimeout(timer);if(!${keepStream}){stream?.getTracks().forEach(t=>t.stop());window.heldCapture=null;}}
  })()`);
  fs.writeFileSync(path.join(out,`${label}.png`),Buffer.from(frame.png.split(',')[1],'base64'));
  result.captures.push({label,targetFound:true,sourceId:target[0].id,size:{width:frame.width,height:frame.height},nonempty:frame.width>0&&frame.height>0,generation:frame.generation,trackId:frame.trackId,trackState:frame.trackState,atUtc:frame.atUtc});save();
  if(geometry){
   if(!frame.patch||frame.patch.count<400)throw Error('Synthetic color patch not identified');
   const [l,t,r,b]=geometry.extended_rect;
   // Pixel centers, measured frame extent; never assume GetWindowRect includes only visible pixels.
   const pixel=[(frame.patch.minX+frame.patch.maxX+1)/2,(frame.patch.minY+frame.patch.maxY+1)/2];
   const mapped=[l+pixel[0]*(r-l)/frame.width,t+pixel[1]*(b-t)/frame.height];
   const p=geometry.patch_rect;const expected=[(p[0]+p[2])/2,(p[1]+p[3])/2];
   const error=mapped.map((v,i)=>v-expected[i]);
   result.captures.at(-1).mapping={geometry,patch:frame.patch,pixel,mapped,expected,error};save();
   if(error.some(e=>Math.abs(e)>2))throw Error('Mapping exceeds 2 physical pixels; no input sent');
   if(sendInput)fs.writeFileSync(path.join(childOut,recoveryProbe?'recovery-click.json':`frame-click-${geometry.round}.json`),JSON.stringify({epoch:geometry.epoch,extended_rect:geometry.extended_rect,point:mapped.map(Math.round)}));
  }
 }
 async function renderer(code){let timer;try{return await Promise.race([panel.webContents.executeJavaScript(code,true),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('renderer operation timeout')),15000)})]);}finally{clearTimeout(timer);}}
 async function releaseCapture(){return renderer(`(()=>{const stream=window.heldCapture;const tracks=stream?.getTracks()||[];const before=tracks.map(t=>({id:t.id,state:t.readyState}));tracks.forEach(t=>t.stop());document.querySelector('video').srcObject=null;window.heldCapture=null;return {atUtc:new Date().toISOString(),before,after:tracks.map(t=>({id:t.id,state:t.readyState})),events:window.troopCaptureEvents||[]};})()`);}
 function trace(){const f=path.join(childOut,'events.jsonl');return fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse):[];}
 async function waitFor(check,label,timeout=600000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(child.exitCode!==null||exit)throw Error('Native test window closed');const t=trace();if(t.some(e=>['user_stop','emergency_hotkey'].includes(e.event)))throw Error('User stopped exercise');if(check(t))return t;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+label);}
 try{
  if(recoveryProbe){
   const beforeFile=path.join(childOut,'recovery-before.json');
   await waitFor(()=>fs.existsSync(beforeFile),'start recovery exercise');
   await sample('before-lock',JSON.parse(fs.readFileSync(beforeFile,'utf8')),{keepStream:true,sendInput:false});
   if(!result.captures.at(-1)?.mapping)throw Error('No verified pre-lock image');
   result.preflightRelease=await releaseCapture();save();
   if(!result.preflightRelease.after.length||result.preflightRelease.after.some(t=>t.state!=='ended'))throw Error('Preflight release failed');
   await sample('before-lock-recreated',JSON.parse(fs.readFileSync(beforeFile,'utf8')),{keepStream:true,sendInput:false});
   if(!result.captures.at(-1)?.mapping)throw Error('No verified pre-lock recreated image');
   result.stage='ready-for-manual-lock';save();
   await renderer(`document.getElementById('status').textContent='已准备，可手动锁屏。解锁后返回原生测试窗，点击重新观察并保持前台数秒。'`);
   await waitFor(t=>t.some(e=>e.event==='wts_detail'&&e.data.change===7),'real lock');
   result.lockObservedAtUtc=new Date().toISOString();save();
   result.release=await releaseCapture();save();
   if(!result.release.after.length||result.release.after.some(t=>t.state!=='ended'))throw Error('Old capture tracks were not released');
   await waitFor(t=>t.some(e=>e.event==='wts_detail'&&e.data.change===8),'real unlock');
   result.stage='awaiting-manual-reobserve';save();
   const afterFile=path.join(childOut,'recovery-after.json');
   await waitFor(()=>fs.existsSync(afterFile),'manual re-observation');
   const before=JSON.parse(fs.readFileSync(beforeFile,'utf8'));const after=JSON.parse(fs.readFileSync(afterFile,'utf8'));
   if(after.epoch<=before.epoch||!after.after_unlock)throw Error('Missing fresh post-unlock observation');
   await new Promise(r=>setTimeout(r,300));
   await sample('after-unlock-new-observation',after);
   const frames=result.captures.filter(c=>c.mapping);
   if(frames.length!==3||frames[2].generation<=frames[1].generation||frames[2].trackId===frames[1].trackId)throw Error('New capture stream not proven');
   await waitFor(t=>t.some(e=>e.event==='recovery_click_verified'),'fresh frame click',15000);
   result.nativeTrace=trace();result.stage='recovery-complete';result.completedAtUtc=new Date().toISOString();save();
   await renderer(`document.getElementById('status').textContent='恢复演练完成：旧流已释放，青色新帧已取得，新点击已命中。'`);
  }else if(frameProbe){
   for(let round=1;round<=2;round++){
    const geomFile=path.join(childOut,`geometry-${round}.json`);const deadline=Date.now()+90000;
    while(!fs.existsSync(geomFile)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
    if(!fs.existsSync(geomFile))throw Error('No foreground geometry; input remains closed');
    const geometry=JSON.parse(fs.readFileSync(geomFile,'utf8'));await new Promise(r=>setTimeout(r,300));await sample(`frame-round-${round}`,geometry);
    await new Promise(r=>setTimeout(r,400));
   }
   result.nativeTrace=fs.readFileSync(path.join(childOut,'events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
  }else{await new Promise(r=>setTimeout(r,1800));await sample('native-window');}
  child.kill();await new Promise(r=>setTimeout(r,1000));await sample('after-target-close');
 }catch(e){result.error=String(e);result.errorStack=e.stack;if(recoveryProbe){result.nativeTrace=trace();try{result.cleanupRelease=await releaseCapture();}catch(cleanupError){result.cleanupError=String(cleanupError);}}}
 if(child.exitCode===null)child.kill();result.childExit=exit;result.childStderr=childError;fs.writeFileSync(path.join(out,'capture-results.json'),JSON.stringify(result,null,2)+'\n');
 // Keep the final screenshot panel visible for review, no active control loop.
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{if(child&&child.exitCode===null)child.kill();if(result){result.panelClosed=true;save();}});
