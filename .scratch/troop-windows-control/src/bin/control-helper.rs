// THROWAWAY. Own child target only; inherited stdin commands + separate kernel stop event.
#[path="../isolation_common.rs"]mod common;
use common::*;
use serde_json::{json,Value};
use std::{io::{BufRead,BufReader,Write},mem::{zeroed,size_of},os::windows::process::CommandExt,path::PathBuf,process::{Command,Stdio},ptr::{null,null_mut},sync::{Arc,Mutex,mpsc,atomic::{AtomicBool,AtomicUsize,Ordering}},thread,time::{Duration,Instant}};
use windows_sys::Win32::{Foundation::*,System::{Threading::*,JobObjects::*},UI::{WindowsAndMessaging::*,HiDpi::*,Input::KeyboardAndMouse::*,Accessibility::*}};
static TARGET:AtomicUsize=AtomicUsize::new(0);
static FOCUS_LOST:AtomicBool=AtomicBool::new(false);
static STOP_ACK:AtomicUsize=AtomicUsize::new(0);
unsafe extern "system" fn focus_event(_:HWINEVENTHOOK,_:u32,h:HWND,_:i32,_:i32,_:u32,_:u32){if h as usize!=TARGET.load(Ordering::SeqCst){FOCUS_LOST.store(true,Ordering::SeqCst);}}
#[derive(Clone)]struct Action{epoch:u64,point:[i32;2],due:Instant}
struct State{epoch:u64,grant:bool,stopped:bool,observed:Option<(Instant,[i32;4])>,pending:Option<Action>,lease_until:Instant}
fn stop(state:&Mutex<State>,reason:&str){let mut s=state.lock().unwrap();if s.stopped{return;}let discarded=s.pending.take().is_some();s.epoch+=1;s.grant=false;s.stopped=true;s.observed=None;unsafe{SetEvent(STOP_ACK.load(Ordering::SeqCst) as HANDLE);}emit("stop_ack",json!({"reason":reason,"epoch":s.epoch,"discarded":discarded,"grant":s.grant}));}
fn main(){unsafe{
 let args:Vec<_>=std::env::args().collect();
 if args.get(1).map(String::as_str)==Some("--environment-snapshot"){emit("environment_snapshot",json!({"active_default_unlocked_local_session":active_session(),"sender_integrity":integrity(GetCurrentProcessId()),"sender_ui_access":ui_access(GetCurrentProcessId())}));return;}
 if args.get(1).map(String::as_str)==Some("--read-owned-target-hits"){
  let h=args[2].parse::<usize>().unwrap() as HWND;let pid=args[3].parse::<u32>().unwrap();assert!(owned_target(h,pid));let n=GetPropW(h,wide("TroopPrototypeHitCountPlusOne").as_ptr()) as usize;assert!(n>0);emit("target_hit_counter",json!({"hits":n-1}));return;
 }
 if args.get(1).map(String::as_str)==Some("--wait-owned-target-exit"){
  let pid=args[2].parse::<u32>().unwrap();let p=OpenProcess(PROCESS_SYNCHRONIZE,0,pid);if p.is_null(){let error=GetLastError();emit("target_open_failed",json!({"pid":pid,"error":error,"exited":error==ERROR_INVALID_PARAMETER}));if error!=ERROR_INVALID_PARAMETER{std::process::exit(2);}return;}let exited=WaitForSingleObject(p,1000)==WAIT_OBJECT_0;CloseHandle(p);emit("target_exit_check",json!({"pid":pid,"exited":exited}));if !exited{std::process::exit(2);}return;
 }
 if args.get(1).map(String::as_str)==Some("--signal-stop"){
  let name=args.get(2).expect("event");assert!(name.starts_with("Local\\TROOP-prototype-stop-"));let h=OpenEventW(EVENT_MODIFY_STATE,0,wide(name).as_ptr());if h.is_null(){emit("signal_failed",json!({"error":GetLastError()}));std::process::exit(2);}let at=now();let ok=SetEvent(h);CloseHandle(h);let ack=if let Some(name)=args.get(3){let h=OpenEventW(SYNCHRONIZATION_SYNCHRONIZE,0,wide(name).as_ptr());let acknowledged=!h.is_null()&&WaitForSingleObject(h,2000)==WAIT_OBJECT_0;if !h.is_null(){CloseHandle(h);}acknowledged}else{false};emit("signal_sent",json!({"set_event":ok,"signal_utc_ms":at,"kernel_ack":ack,"ack_utc_ms":now()}));if args.len()>3&&!ack{std::process::exit(2);}return;
 }
 init_async_events();
 let target_exe=PathBuf::from(std::env::current_exe().unwrap()).with_file_name("isolation-target.exe");
 let stop_name=format!("Local\\TROOP-prototype-stop-{}-{}",std::process::id(),now());let event=CreateEventW(null(),1,0,wide(&stop_name).as_ptr());assert!(!event.is_null());
 let ack_name=format!("{stop_name}-ack");let ack_event=CreateEventW(null(),1,0,wide(&ack_name).as_ptr());assert!(!ack_event.is_null());STOP_ACK.store(ack_event as usize,Ordering::SeqCst);
 SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
 let job=CreateJobObjectW(null(),null());assert!(!job.is_null());let mut limits:JOBOBJECT_EXTENDED_LIMIT_INFORMATION=zeroed();limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;assert_ne!(SetInformationJobObject(job,JobObjectExtendedLimitInformation,(&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32),0);
 let mut target=Command::new(target_exe).arg(&stop_name).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).creation_flags(CREATE_NO_WINDOW).spawn().unwrap();
 use std::os::windows::io::AsRawHandle;
 if AssignProcessToJobObject(job,target.as_raw_handle() as HANDLE)==0{let _=target.kill();panic!("Cannot fence owned target in job");}
 let target_pid=target.id();let mut reader=BufReader::new(target.stdout.take().unwrap());let mut first=String::new();reader.read_line(&mut first).unwrap();let identity:Value=serde_json::from_str(&first).unwrap();let hwnd=identity["data"]["hwnd"].as_u64().unwrap() as HWND;assert!(owned_target(hwnd,target_pid));
 TARGET.store(hwnd as usize,Ordering::SeqCst);let hook=SetWinEventHook(EVENT_SYSTEM_FOREGROUND,EVENT_SYSTEM_FOREGROUND,null_mut(),Some(focus_event),0,0,WINEVENT_OUTOFCONTEXT);assert!(!hook.is_null());
 let shared=Arc::new(Mutex::new(State{epoch:1,grant:false,stopped:false,observed:None,pending:None,lease_until:Instant::now()+Duration::from_millis(700)}));
 let stop_state=shared.clone();let event_id=event as usize;thread::spawn(move||{WaitForSingleObject(event_id as HANDLE,INFINITE);stop(&stop_state,"independent_stop_event");});
 thread::spawn(move||{for l in reader.lines(){if let Ok(l)=l{if let Ok(value)=serde_json::from_str::<Value>(&l){emit("target_event",value);}}}});
 let (tx,rx)=mpsc::sync_channel::<Value>(8);let eof_state=shared.clone();thread::spawn(move||{for l in std::io::stdin().lock().lines(){match l{Ok(l) if l.len()<=8192=>{if let Ok(v)=serde_json::from_str(&l){if tx.send(v).is_err(){return;}}},_=>break}}stop(&eof_state,"command_channel_eof");});
 let hotkey=RegisterHotKey(null_mut(),1,MOD_CONTROL|MOD_SHIFT|MOD_NOREPEAT,VK_F12 as u32);
 emit("helper_ready",json!({"target":identity["data"],"stop_event":stop_name,"stop_ack_event":ack_name,"epoch":1,"helper_integrity":integrity(GetCurrentProcessId()),"stop_hotkey_registered":hotkey,"target_job_fenced":true}));
 let deadline=Instant::now()+Duration::from_secs(90);let mut last_session_poll=Instant::now();let mut session_ok=active_session();
 loop{
  if Instant::now()>deadline{stop(&shared,"prototype_timeout");break;}
  if target.try_wait().unwrap().is_some(){stop(&shared,"target_exit");break;}
  let expired={let s=shared.lock().unwrap();s.grant&&!s.stopped&&Instant::now()>s.lease_until};if expired{stop(&shared,"coordinator_lease_expired");}
  let mut msg:MSG=zeroed();while PeekMessageW(&mut msg,null_mut(),0,0,PM_REMOVE)!=0{if msg.message==WM_HOTKEY{SetEvent(event);}}
  if last_session_poll.elapsed()>Duration::from_millis(100){session_ok=active_session();last_session_poll=Instant::now();}
  {let mut s=shared.lock().unwrap();if let Some((_,r))=s.observed{if FOCUS_LOST.load(Ordering::SeqCst)||GetForegroundWindow()!=hwnd||rect(hwnd)!=r||!session_ok{let discarded=s.pending.take().is_some();s.observed=None;s.epoch+=1;emit("observation_invalidated",json!({"epoch":s.epoch,"discarded":discarded,"focus_event_latched":FOCUS_LOST.load(Ordering::SeqCst),"session_ok":session_ok}));}}}
  if let Ok(v)=rx.try_recv(){
   let op=v["op"].as_str().unwrap_or("");if op=="exit"{stop(&shared,"driver_exit");break;}
   if op=="diagnostic-fill-output"{for _ in 0..2000{emit("diagnostic_filler",json!({"padding":"x".repeat(4096)}));}continue;}
   if op=="exercise-focus-loss"{if let Some(input)=target.stdin.as_mut(){let _=writeln!(input,"focus-pulse");}continue;}
   if op=="fixture-minimize"||op=="fixture-restore-change"{if let Some(input)=target.stdin.as_mut(){let _=writeln!(input,"{}",if op=="fixture-minimize"{"minimize"}else{"restore-change"});}continue;}
   // OS queries stay outside the shared stop lock; only apply their result if the run remains live.
   let levels=if op=="grant"{Some(integrity_allowed(target_pid))}else{None};
   let r=rect(hwnd);let marker=rect(GetDlgItem(hwnd,201));let point=[marker[0]+26,marker[1]+26];
   let observation_gate=if op=="observe"{input_gate(hwnd,target_pid,r,point)}else{Err("not_observe")};let observation_ok=observation_gate.is_ok();
   let mut s=shared.lock().unwrap();
   if op=="status"{emit("status",json!({"epoch":s.epoch,"stopped":s.stopped,"grant":s.grant,"pending":s.pending.is_some(),"diagnostic_events_dropped":dropped_events()}));}
   else if s.stopped{emit("command_denied",json!({"op":op,"reason":"stopped_requires_new_run","epoch":s.epoch}));}
   else if op=="heartbeat"{s.lease_until=Instant::now()+Duration::from_millis(700);}
   else if op=="grant"{match levels.unwrap(){Ok(levels)=>{s.grant=true;emit("granted",json!({"epoch":s.epoch,"integrity":levels}));},Err(reason)=>emit("command_denied",json!({"op":op,"reason":reason}))}}
   else if op=="observe"{
    if s.grant&&observation_ok{FOCUS_LOST.store(false,Ordering::SeqCst);s.observed=Some((Instant::now(),r));emit("observed",json!({"epoch":s.epoch,"rect":r,"point":point}));}else{emit("command_denied",json!({"op":op,"reason":"observation_gate","detail":observation_gate.err(),"grant":s.grant}));}
   }else if op=="enqueue"{
    let point=v.get("point").and_then(Value::as_array).and_then(|a|if a.len()==2{Some([i32::try_from(a[0].as_i64()?).ok()?,i32::try_from(a[1].as_i64()?).ok()?])}else{None});
    let reason=if !s.grant{"not_authorized"}else if v["target_pid"].as_u64()!=Some(target_pid as u64){"target_identity"}else if v["epoch"].as_u64()!=Some(s.epoch){"stale_epoch"}else if s.observed.is_none(){"no_observation"}else if point.is_none(){"invalid_point"}else if s.pending.is_some(){"queue_full"}else{""};
    if !reason.is_empty(){emit("command_denied",json!({"op":op,"reason":reason}));}else{let delay=v["delay_ms"].as_u64().unwrap_or(0).min(60000);s.pending=Some(Action{epoch:s.epoch,point:point.unwrap(),due:Instant::now()+Duration::from_millis(delay)});emit("queued",json!({"epoch":s.epoch,"delay_ms":delay}));}
   }
  }
  // Stop does not wait for capture or target rendering. Only the final short submission shares this lock.
  let snapshot={let s=shared.lock().unwrap();s.pending.clone().filter(|a|a.due<=Instant::now()).map(|a|(a,s.observed))};
  if let Some((a,observation))=snapshot{
   let validity=match observation{Some((when,r)) if when.elapsed()<Duration::from_secs(5)=>input_gate(hwnd,target_pid,r,a.point).and_then(|_|integrity_allowed(target_pid).map(|_|())),_=>Err("observation_expired")};
   let mut s=shared.lock().unwrap();
   if !s.stopped&&s.grant&&s.epoch==a.epoch&&s.pending.is_some(){s.pending=None;if let Err(reason)=validity{s.observed=None;s.epoch+=1;emit("dispatch_denied",json!({"reason":reason,"epoch":s.epoch}));}else{let (inserted,error)=click(a.point);emit("os_submission",json!({"inserted":inserted,"requested":3,"error":error,"epoch":s.epoch}));if inserted!=3{s.grant=false;s.stopped=true;s.observed=None;s.epoch+=1;SetEvent(ack_event);emit("indeterminate",json!({"no_retry":true}));}}}
  }
  thread::sleep(Duration::from_millis(5));
 }
 UnhookWinEvent(hook);UnregisterHotKey(null_mut(),1);let _=target.kill();let _=target.wait();CloseHandle(job);CloseHandle(event);CloseHandle(ack_event);
}}
