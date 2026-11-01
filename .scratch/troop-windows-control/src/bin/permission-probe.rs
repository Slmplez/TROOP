// THROWAWAY: lower only this test child's integrity. Never elevates or changes system policy.
#[path="../isolation_common.rs"]mod common;
use common::*;
use serde_json::json;
use std::{fs::File,mem::{zeroed,size_of},os::windows::io::AsRawHandle,path::PathBuf,ptr::{null,null_mut}};
use windows_sys::Win32::{Foundation::*,Security::{*,Authorization::*},System::Threading::*,UI::{HiDpi::*,WindowsAndMessaging::*}};
fn main(){unsafe{
 let a:Vec<_>=std::env::args().collect();
 if a.get(1).map(String::as_str)==Some("--child"){
  let hwnd=a[2].parse::<usize>().unwrap() as HWND;let pid=a[3].parse::<u32>().unwrap();
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  let sender=integrity(GetCurrentProcessId());let target=integrity(pid);let policy=integrity_allowed(pid);
  let marker=rect(GetDlgItem(hwnd,201));let point=[marker[0]+26,marker[1]+26];
  let preflight=input_gate(hwnd,pid,rect(hwnd),point);
  // Diagnostic call is intentionally separate from the product policy gate. Own synthetic target only.
  let diagnostic=a.get(4).map(String::as_str)==Some("--diagnostic");
  let attempted=diagnostic&&sender==Some(4096)&&target.map(|v|v>4096).unwrap_or(false)&&preflight.is_ok();
  let policy_attempted=!diagnostic&&policy.is_ok()&&preflight.is_ok();
  let (inserted,error)=if attempted||policy_attempted{click(point)}else{(0,0)};
  println!("{}",json!({"senderIntegrity":sender,"targetIntegrity":target,"senderUiAccess":ui_access(GetCurrentProcessId()),"targetUiAccess":ui_access(pid),"policyDenied":policy.is_err(),"policyReason":policy.err(),"preflightAllowed":preflight.is_ok(),"preflightReason":preflight.err(),"diagnosticCallAttempted":attempted,"policyPathOsCalls":if policy_attempted{1}else{0},"inserted":inserted,"lastError":error,"requested":if attempted||policy_attempted{3}else{0},"note":"Return/error alone cannot identify UIPI; correlate actual integrity tokens and same-target positive control."}));
  return;
 }
 assert!(a.len()==4||a.len()==5);let hwnd=a[1].parse::<usize>().unwrap() as HWND;let pid=a[2].parse::<u32>().unwrap();assert!(owned_target(hwnd,pid));let diagnostic=a.get(4).map(String::as_str)==Some("--diagnostic");
 let output=PathBuf::from(&a[3]).join(if diagnostic{"permission-diagnostic.json"}else{"permission-child.json"});let file=File::create(output).unwrap();let output_handle=file.as_raw_handle() as HANDLE;assert_ne!(SetHandleInformation(output_handle,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT),0);
 let mut original=null_mut();assert_ne!(OpenProcessToken(GetCurrentProcess(),TOKEN_DUPLICATE|TOKEN_QUERY|TOKEN_ADJUST_DEFAULT|TOKEN_ASSIGN_PRIMARY,&mut original),0);
 let mut restricted=null_mut();assert_ne!(CreateRestrictedToken(original,DISABLE_MAX_PRIVILEGE,0,null(),0,null(),0,null(),&mut restricted),0);CloseHandle(original);
 let no_ui_access=0u32;if SetTokenInformation(restricted,TokenUIAccess,(&no_ui_access as *const u32).cast(),4)==0{emit("clear_ui_access_failed",json!({"error":GetLastError()}));std::process::exit(2);}
 let mut sid=null_mut();assert_ne!(ConvertStringSidToSidW(wide("S-1-16-4096").as_ptr(),&mut sid),0);
 let label=TOKEN_MANDATORY_LABEL{Label:SID_AND_ATTRIBUTES{Sid:sid,Attributes:windows_sys::Win32::System::SystemServices::SE_GROUP_INTEGRITY as u32}};
 if SetTokenInformation(restricted,TokenIntegrityLevel,(&label as *const TOKEN_MANDATORY_LABEL).cast(),size_of::<TOKEN_MANDATORY_LABEL>() as u32+GetLengthSid(sid))==0{emit("lower_integrity_failed",json!({"error":GetLastError()}));std::process::exit(2);}
 let exe=std::env::current_exe().unwrap();let exe_text=exe.to_string_lossy();let mut cmd=wide(&format!("\"{}\" --child {} {} {}",exe_text,hwnd as usize,pid,if diagnostic{"--diagnostic"}else{"--policy-only"}));
 let mut startup:STARTUPINFOW=zeroed();startup.cb=size_of::<STARTUPINFOW>() as u32;startup.dwFlags=STARTF_USESTDHANDLES;startup.hStdOutput=output_handle;startup.hStdError=output_handle;startup.hStdInput=null_mut();
 let mut process:PROCESS_INFORMATION=zeroed();let created=CreateProcessAsUserW(restricted,wide(&exe_text).as_ptr(),cmd.as_mut_ptr(),null(),null(),1,CREATE_NO_WINDOW,null(),null(),&startup,&mut process);
 let error=GetLastError();CloseHandle(restricted);LocalFree(sid);
 if created==0{emit("low_integrity_spawn_failed",json!({"error":error,"no_elevation_attempted":true}));std::process::exit(2);}
 emit("low_integrity_spawned",json!({"pid":process.dwProcessId,"target_pid":pid,"target_integrity":integrity(pid)}));
 if WaitForSingleObject(process.hProcess,10000)!=WAIT_OBJECT_0{TerminateProcess(process.hProcess,3);CloseHandle(process.hThread);CloseHandle(process.hProcess);std::process::exit(3);}
 let mut code=0;GetExitCodeProcess(process.hProcess,&mut code);CloseHandle(process.hThread);CloseHandle(process.hProcess);SetHandleInformation(output_handle,HANDLE_FLAG_INHERIT,0);std::process::exit(code as i32);
}}
