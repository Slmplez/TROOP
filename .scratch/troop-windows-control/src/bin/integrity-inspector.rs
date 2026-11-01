// THROWAWAY: reads a known owned fixture; never calls SendInput.
#[path="../isolation_common.rs"]mod common;
use common::*;
use serde_json::{json,Value};
use windows_sys::Win32::Foundation::HWND;
fn main(){unsafe{
 let file=std::env::args().nth(1).expect("target identity JSON");let target:Value=serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();let pid=target["pid"].as_u64().unwrap() as u32;let hwnd=target["hwnd"].as_u64().unwrap() as HWND;
 assert!(owned_target(hwnd,pid));let own=std::process::id();let sender=integrity(own).unwrap();let target_level=integrity(pid).unwrap();let policy=integrity_allowed(pid);let denied=matches!(policy,Err("higher_integrity_target"));
 emit("administrator_boundary",json!({"senderIntegrity":sender,"targetIntegrity":target_level,"senderUiAccess":ui_access(own),"targetUiAccess":ui_access(pid),"targetPid":pid,"policyDenied":denied,"reason":policy.err(),"osInputCalls":0,"utc_ms":now()}));
 if !denied||sender>=target_level{std::process::exit(2);}
}}
