// THROWAWAY capture comparison. No old application code is loaded.
const {app, BrowserWindow, desktopCapturer, screen} = require('electron');
const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
const root=process.env.TROOP_PROTOTYPE_ROOT;
if(!root)throw Error('Run via run-capture.ps1');
const frameProbe=process.env.TROOP_FRAME_PROBE==='1';
const mappingOnly=process.env.TROOP_MAPPING_ONLY==='1';
const out=frameProbe?fs.mkdtempSync(path.join(root,'.tmp-host-control/frame-capture-')):path.join(root,'.tmp-host-control/electron-target-capture');fs.mkdirSync(out,{recursive:true});
if(frameProbe)fs.writeFileSync(path.join(root,'.tmp-host-control/latest-frame-run.json'),JSON.stringify({directory:out}));
app.setPath('userData',path.join(out,'profile'));
if(process.env.TROOP_CAPTURE_SOFTWARE==='1')app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
let child;let panel;let result;
function save(){if(result)fs.writeFileSync(path.join(out,'capture-results.json'),JSON.stringify(result,null,2)+'\n');}
process.on('uncaughtException',e=>{if(result){result.fatal=String(e);save();}app.quit();});
process.on('unhandledRejection',e=>{if(result){result.fatal=String(e);save();}app.quit();});
app.whenReady().then(async()=>{
 result={electron:process.versions.electron,chrome:process.versions.chrome,scope:'Zero-thumbnail enumeration followed by media capture of exact own synthetic HWND',hardwareAcceleration:app.isHardwareAccelerationEnabled(),displays:screen.getAllDisplays().map(d=>({bounds:d.bounds,scaleFactor:d.scaleFactor,rotation:d.rotation})),captures:[],stage:'ready'};save();
 panel=new BrowserWindow({title:'TROOP 捕获对照 — 专用测试窗',width:960,height:780,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 panel.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 const panelPath=path.join(out,'panel.html');fs.writeFileSync(panelPath,'<meta charset="utf-8"><h2>TROOP 专用窗口捕获对照</h2><p>枚举不生成缩略图，然后仅捕获指定 HWND。</p><video muted autoplay style="max-width:100%"></video>');await panel.loadFile(panelPath);
 const childOut=path.join(out,'native');
 child=spawn(path.join(root,'.tmp-host-control/build/debug/troop-host-control-prototype.exe'),[childOut,...(frameProbe?['--frame-probe']:[]),...(mappingOnly?['--mapping-only']:[])],{cwd:root,windowsHide:false,stdio:['ignore','ignore','pipe']});
 result.mappingOnly=mappingOnly;
 result.stage='native-started';save();
 let childError='';child.stderr.on('data',b=>childError+=b.toString());
 let exit;child.once('exit',(code,signal)=>{exit={code,signal};});
 async function sample(label,geometry){
  const file=path.join(childOut,'events.jsonl');if(!fs.existsSync(file)){result.captures.push({label,error:'native did not produce identity'});return;}
  const startup=JSON.parse(fs.readFileSync(file,'utf8').split('\n')[0]);const hwnd=String(startup.data.hwnd);
  result.stage='enumerating-'+label;save();
  let timer;const sources=await Promise.race([desktopCapturer.getSources({types:['window'],thumbnailSize:{width:0,height:0},fetchWindowIcons:false}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('enumeration timeout after 10 seconds')),10000)})]).finally(()=>clearTimeout(timer));
  const target=sources.filter(s=>s.id.split(':')[1]===hwnd&&s.name==='TROOP 宿主控制原型 — 仅专用测试窗口');
  if(target.length!==1){result.captures.push({label,targetFound:false,ownTitleCandidates:sources.filter(s=>s.name==='TROOP 宿主控制原型 — 仅专用测试窗口').map(s=>s.id)});return;}
  result.stage='media-'+label;save();
  const frame=await panel.webContents.executeJavaScript(`(async()=>{
   let stream;let timer;
   try{stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:${JSON.stringify(target[0].id)}}}});
    const video=document.querySelector('video');video.srcObject=stream;await video.play();
    await Promise.race([new Promise(resolve=>video.requestVideoFrameCallback(resolve)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('video frame timeout')),8000)})]);
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);
    const rgba=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let minX=canvas.width,minY=canvas.height,maxX=-1,maxY=-1,count=0;
    for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){const i=(y*canvas.width+x)*4;if(rgba[i]>220&&rgba[i+1]<50&&rgba[i+2]>220){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);count++;}}
    return {width:canvas.width,height:canvas.height,png:canvas.toDataURL('image/png'),patch:count?{minX,minY,maxX,maxY,count}:null};
   }finally{clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());}
  })()`,true);
  fs.writeFileSync(path.join(out,`${label}.png`),Buffer.from(frame.png.split(',')[1],'base64'));
  result.captures.push({label,targetFound:true,sourceId:target[0].id,size:{width:frame.width,height:frame.height},nonempty:frame.width>0&&frame.height>0});save();
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
   fs.writeFileSync(path.join(childOut,`frame-click-${geometry.round}.json`),JSON.stringify({epoch:geometry.epoch,extended_rect:geometry.extended_rect,point:mapped.map(Math.round)}));
  }
 }
 try{
  if(frameProbe){
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
 }catch(e){result.error=String(e);}
 if(child.exitCode===null)child.kill();result.childExit=exit;result.childStderr=childError;fs.writeFileSync(path.join(out,'capture-results.json'),JSON.stringify(result,null,2)+'\n');
 // Keep the final screenshot panel visible for review, no active control loop.
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{if(child&&child.exitCode===null)child.kill();if(result){result.panelClosed=true;save();}});
