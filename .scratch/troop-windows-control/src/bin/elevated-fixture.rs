#![windows_subsystem="windows"]
// THROWAWAY: a passive, self-closing target for a human-approved UAC drill.
#[path="../isolation_common.rs"]mod common;
use common::*;
use serde_json::json;
use std::{mem::zeroed,path::PathBuf,ptr::{null,null_mut}};
use windows_sys::Win32::{Foundation::*,Graphics::Gdi::*,System::LibraryLoader::*,UI::WindowsAndMessaging::*};
unsafe extern "system" fn wndproc(h:HWND,m:u32,w:WPARAM,l:LPARAM)->LRESULT{
 match m{WM_TIMER=>{DestroyWindow(h);return 0;},WM_DESTROY=>{PostQuitMessage(0);return 0;},_=>{}}
 DefWindowProcW(h,m,w,l)
}
fn main(){unsafe{
 let output=PathBuf::from(std::env::args().nth(1).expect("owned output directory"));assert!(output.is_dir());
 let instance=GetModuleHandleW(null());let class=wide("TroopIsolationTarget");let mut c:WNDCLASSW=zeroed();c.lpfnWndProc=Some(wndproc);c.hInstance=instance;c.lpszClassName=class.as_ptr();c.hbrBackground=(COLOR_WINDOW+1) as HBRUSH;RegisterClassW(&c);
 let h=CreateWindowExW(0,class.as_ptr(),wide("TROOP 管理员边界 — 只读验证，60 秒自动关闭").as_ptr(),WS_OVERLAPPEDWINDOW,250,150,760,290,null_mut(),null_mut(),instance,null());assert!(!h.is_null());
 CreateWindowExW(0,wide("STATIC").as_ptr(),wide("此专用窗口仅用于核对完整性权限。\r\n普通权限检查器只读取身份与令牌，不发送点击或键盘输入。\r\n没有系统设置变更；60 秒后自动退出，也可手动关闭。").as_ptr(),WS_CHILD|WS_VISIBLE,20,30,700,160,h,null_mut(),instance,null());
 ShowWindow(h,SW_SHOW);UpdateWindow(h);assert_ne!(SetTimer(h,1,60000,None),0);
 let pid=std::process::id();let ready=json!({"pid":pid,"hwnd":h as usize,"integrity":integrity(pid),"uiAccess":ui_access(pid),"utc_ms":now(),"scope":"passive own fixture; no input; self-closes in 60 seconds"});
 std::fs::write(output.join("elevated-target.json"),serde_json::to_vec_pretty(&ready).unwrap()).unwrap();
 let mut msg:MSG=zeroed();while GetMessageW(&mut msg,null_mut(),0,0)>0{TranslateMessage(&msg);DispatchMessageW(&msg);}
 std::fs::write(output.join("elevated-target-closed.json"),serde_json::to_vec_pretty(&json!({"pid":pid,"utc_ms":now(),"closed":true})).unwrap()).unwrap();
}}
