// Shared only by throwaway isolation probes, never a general desktop-control API.
#![allow(dead_code)]
use serde_json::{json,Value};
use std::{mem::{zeroed,size_of},ptr::null_mut,sync::{OnceLock,mpsc},time::{SystemTime,UNIX_EPOCH}};
use windows_sys::Win32::{Foundation::*,Security::*,System::{Threading::*,RemoteDesktop::*,StationsAndDesktops::*},UI::{WindowsAndMessaging::*,Input::KeyboardAndMouse::*}};
pub fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}
pub fn now()->u128{SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()}
static ASYNC_EVENTS:OnceLock<mpsc::SyncSender<Value>>=OnceLock::new();
static DROPPED_EVENTS:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
pub fn dropped_events()->usize{DROPPED_EVENTS.load(std::sync::atomic::Ordering::Relaxed)}
pub fn init_async_events(){let(tx,rx)=mpsc::sync_channel(128);ASYNC_EVENTS.set(tx).unwrap();std::thread::spawn(move||{for v in rx{println!("{v}");}});}
pub fn emit(event:&str,data:Value){let v=json!({"utc_ms":now(),"pid":std::process::id(),"event":event,"data":data});if let Some(tx)=ASYNC_EVENTS.get(){if tx.try_send(v).is_err(){DROPPED_EVENTS.fetch_add(1,std::sync::atomic::Ordering::Relaxed);}}else{println!("{v}");}}
pub unsafe fn rect(h:HWND)->[i32;4]{let mut r:RECT=zeroed();GetWindowRect(h,&mut r);[r.left,r.top,r.right,r.bottom]}
pub unsafe fn integrity(pid:u32)->Option<u32>{
 let p=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,0,pid);if p.is_null(){return None;}
 let mut token=null_mut();if OpenProcessToken(p,TOKEN_QUERY,&mut token)==0{CloseHandle(p);return None;}CloseHandle(p);
 let mut bytes=0;GetTokenInformation(token,TokenIntegrityLevel,null_mut(),0,&mut bytes);
 let mut buf=vec![0usize;(bytes as usize+size_of::<usize>()-1)/size_of::<usize>()];
 let ok=GetTokenInformation(token,TokenIntegrityLevel,buf.as_mut_ptr().cast(),bytes,&mut bytes);CloseHandle(token);
 if ok==0{return None;}let label=&*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);let n=*GetSidSubAuthorityCount(label.Label.Sid);if n==0{return None;}Some(*GetSidSubAuthority(label.Label.Sid,(n-1) as u32))
}
pub unsafe fn integrity_allowed(target_pid:u32)->Result<(u32,u32),&'static str>{
 let own=integrity(GetCurrentProcessId()).ok_or("sender_integrity_unknown")?;
 let target=integrity(target_pid).ok_or("target_integrity_unknown")?;
 if own<target{Err("higher_integrity_target")}else{Ok((own,target))}
}
pub unsafe fn ui_access(pid:u32)->Option<u32>{let p=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,0,pid);if p.is_null(){return None;}let mut token=null_mut();let ok=OpenProcessToken(p,TOKEN_QUERY,&mut token);CloseHandle(p);if ok==0{return None;}let mut value=0u32;let mut n=0;let ok=GetTokenInformation(token,TokenUIAccess,(&mut value as *mut u32).cast(),4,&mut n);CloseHandle(token);if ok==0{None}else{Some(value)}}
pub unsafe fn active_session()->bool{
 let mut p=null_mut();let mut n=0;let mut active=false;
 if WTSQuerySessionInformationW(null_mut(),u32::MAX,WTSSessionInfoEx,&mut p,&mut n)!=0&&n as usize>=size_of::<WTSINFOEXW>(){let i=&*(p as *const WTSINFOEXW);if i.Level==1{let l=i.Data.WTSInfoExLevel1;active=l.SessionState==WTSActive&&l.SessionFlags==WTS_SESSIONSTATE_UNLOCK as i32;}}
 if !p.is_null(){WTSFreeMemory(p.cast());}let desktop=OpenInputDesktop(0,0,DESKTOP_READOBJECTS);if desktop.is_null(){return false;}
 let mut name=[0u16;80];let mut bytes=0;let ok=GetUserObjectInformationW(desktop,UOI_NAME,name.as_mut_ptr().cast(),160,&mut bytes);CloseDesktop(desktop);
 active&&ok!=0&&String::from_utf16_lossy(&name[..name.iter().position(|c|*c==0).unwrap_or(80)])=="Default"&&GetSystemMetrics(SM_REMOTESESSION)==0
}
pub unsafe fn owned_target(hwnd:HWND,pid:u32)->bool{
 let mut owner=0;GetWindowThreadProcessId(hwnd,&mut owner);let mut cls=[0u16;128];let n=GetClassNameW(hwnd,cls.as_mut_ptr(),128);
 owner==pid&&IsWindow(hwnd)!=0&&String::from_utf16_lossy(&cls[..n.max(0) as usize])=="TroopIsolationTarget"
}
pub unsafe fn input_gate(hwnd:HWND,pid:u32,expected:[i32;4],point:[i32;2])->Result<(),&'static str>{
 if !owned_target(hwnd,pid){return Err("target_identity");}if !active_session(){return Err("session_unavailable");}
 if GetForegroundWindow()!=hwnd||IsIconic(hwnd)!=0{return Err("target_not_foreground");}if rect(hwnd)!=expected{return Err("geometry_changed");}
 if [VK_SHIFT,VK_CONTROL,VK_MENU,VK_LWIN,VK_RWIN].iter().any(|k|GetAsyncKeyState(*k as i32)<0){return Err("modifier_held");}
 let marker=GetDlgItem(hwnd,201);let r=rect(marker);if point[0]<r[0]||point[0]>=r[2]||point[1]<r[1]||point[1]>=r[3]||WindowFromPoint(POINT{x:point[0],y:point[1]})!=marker{return Err("point_not_own_marker");}Ok(())
}
pub unsafe fn click(point:[i32;2])->(u32,u32){
 let x0=GetSystemMetrics(SM_XVIRTUALSCREEN);let y0=GetSystemMetrics(SM_YVIRTUALSCREEN);let w=GetSystemMetrics(SM_CXVIRTUALSCREEN);let h=GetSystemMetrics(SM_CYVIRTUALSCREEN);if w<=1||h<=1{return (0,87);}
 let x=((point[0]-x0) as i64*65535/(w-1) as i64) as i32;let y=((point[1]-y0) as i64*65535/(h-1) as i64) as i32;
 let inputs:Vec<INPUT>=[MOUSEEVENTF_MOVE|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK,MOUSEEVENTF_LEFTDOWN,MOUSEEVENTF_LEFTUP].into_iter().map(|flags|INPUT{r#type:INPUT_MOUSE,Anonymous:INPUT_0{mi:MOUSEINPUT{dx:x,dy:y,mouseData:0,dwFlags:flags,time:0,dwExtraInfo:0}}}).collect();
 SetLastError(0);let inserted=SendInput(3,inputs.as_ptr(),size_of::<INPUT>() as i32);(inserted,if inserted==3{0}else{GetLastError()})
}
