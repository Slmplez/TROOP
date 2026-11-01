// THROWAWAY: captures only the controller's owned synthetic target; never sends input.
const {app,BrowserWindow,desktopCapturer}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const dir=process.env.TROOP_ISOLATION_DIR;
if(!dir)throw Error('Run via run-isolation.ps1');
app.setPath('userData',path.join(dir,'capture-profile'));
app.commandLine.appendSwitch('disable-background-networking');
const log=(event,data={})=>fs.appendFileSync(path.join(dir,'capture-events.jsonl'),JSON.stringify({event,data,utc_ms:Date.now(),pid:process.pid})+'\n');
app.whenReady().then(async()=>{
 const target=JSON.parse(fs.readFileSync(path.join(dir,'target.json'),'utf8'));
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const html=path.join(dir,'capture.html');fs.writeFileSync(html,'<meta charset="utf-8"><video autoplay muted></video>');await win.loadFile(html);
 const sources=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:0,height:0},fetchWindowIcons:false});
 const found=sources.filter(s=>s.id.split(':')[1]===String(target.hwnd)&&s.name==='TROOP 独立控制 — 仅专用目标窗口');
 if(found.length!==1)throw Error('Exact synthetic HWND not found');
 const frame=await win.webContents.executeJavaScript(`(async()=>{
  const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:${JSON.stringify(found[0].id)}}}});window.troopStream=stream;
  const video=document.querySelector('video');video.srcObject=stream;await video.play();await new Promise(r=>video.requestVideoFrameCallback(r));
  const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;const ctx=c.getContext('2d');ctx.drawImage(video,0,0);
  const p=ctx.getImageData(0,0,c.width,c.height).data;let l=c.width,t=c.height,r=-1,b=-1,count=0;
  for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){let i=(y*c.width+x)*4;if(p[i]>220&&p[i+1]<50&&p[i+2]>220){l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);count++;}}
  return {width:c.width,height:c.height,patch:[l,t,r,b],count,trackState:stream.getVideoTracks()[0].readyState};
 })()`,true);
 if(frame.count<400)throw Error('Synthetic patch missing');
 const [l,t,r,b]=target.extended_rect;const [px,py,qx,qy]=frame.patch;
 const point=[l+(px+qx+1)/2*(r-l)/frame.width,t+(py+qy+1)/2*(b-t)/frame.height];
 const expected=[target.marker_rect[0]+26,target.marker_rect[1]+26];
 const error=point.map((n,i)=>n-expected[i]);if(error.some(n=>Math.abs(n)>2))throw Error('Frame mapping outside tolerance');
 const ready={target_pid:target.pid,frame,point:point.map(Math.round),error,sourceId:found[0].id};
 log('capture_ready',ready);fs.writeFileSync(path.join(dir,'capture-ready.json'),JSON.stringify(ready));
 let lastSnapshot=null;let snapshotBusy=false;
 setInterval(async()=>{
  const faultFile=path.join(dir,'capture-fault.json');
  if(fs.existsSync(faultFile)){
   const mode=JSON.parse(fs.readFileSync(faultFile,'utf8')).mode;
   if(mode==='hang'){log('capture_hang_injected',{kind:'blocked main event loop after real capture'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
   if(mode==='exit'){log('capture_exit_injected',{exitCode:73});app.exit(73);}
   const request=JSON.parse(fs.readFileSync(faultFile,'utf8'));
   if(mode==='snapshot'&&!snapshotBusy&&lastSnapshot!==request.id){
    snapshotBusy=true;lastSnapshot=request.id;
    try{
     const snapshot=await win.webContents.executeJavaScript(`(async()=>{
      const video=document.querySelector('video');let oldState=null;
      if(${request.restart===true}){const old=window.troopStream?.getTracks()||[];old.forEach(t=>t.stop());oldState=old.map(t=>t.readyState);window.troopStream=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:${JSON.stringify(found[0].id)}}}});video.srcObject=window.troopStream;await video.play();}
      let timer;const newFrame=await Promise.race([new Promise(r=>video.requestVideoFrameCallback(()=>r(true))),new Promise(r=>{timer=setTimeout(()=>r(false),1000)})]);clearTimeout(timer);
      let magenta=0,cyan=0;if(newFrame){const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;const ctx=c.getContext('2d');ctx.drawImage(video,0,0);const rgba=ctx.getImageData(0,0,c.width,c.height).data;for(let i=0;i<rgba.length;i+=4){if(rgba[i]>220&&rgba[i+1]<50&&rgba[i+2]>220)magenta++;if(rgba[i]<50&&rgba[i+1]>220&&rgba[i+2]>220)cyan++;}}
      return {newFrame,width:video.videoWidth,height:video.videoHeight,magenta,cyan,oldState,trackStates:window.troopStream?.getTracks().map(t=>t.readyState)||[]};
     })()`,true);
     const snapshotSources=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:0,height:0},fetchWindowIcons:false});snapshot.targetEnumerated=snapshotSources.some(s=>s.id.split(':')[1]===String(target.hwnd)&&s.name==='TROOP 独立控制 — 仅专用目标窗口');
     log('lifecycle_snapshot',{id:request.id,...snapshot});fs.writeFileSync(path.join(dir,`snapshot-${request.id}.json`),JSON.stringify(snapshot));
    }catch(e){log('lifecycle_error',{id:request.id,error:String(e)});fs.writeFileSync(path.join(dir,`snapshot-${request.id}.json`),JSON.stringify({error:String(e)}));}finally{snapshotBusy=false;}
   }
  }
 },20);
 setInterval(()=>log('capture_heartbeat'),100);
}).catch(e=>{log('capture_error',{message:String(e)});app.exit(2);});
