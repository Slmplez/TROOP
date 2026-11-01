#![windows_subsystem="windows"]
#[path="../isolation_common.rs"]mod common;
use common::*;
use serde_json::json;
use std::{io::BufRead,mem::{zeroed,size_of},ptr::{null,null_mut},sync::atomic::{AtomicUsize,Ordering}};
use windows_sys::Win32::{Foundation::*,Graphics::{Gdi::*,Dwm::*},System::{Threading::*,LibraryLoader::*},UI::{WindowsAndMessaging::*,HiDpi::*,Controls::DRAWITEMSTRUCT}};
static STOP:AtomicUsize=AtomicUsize::new(0);
static HITS:AtomicUsize=AtomicUsize::new(0);
static POPUP:AtomicUsize=AtomicUsize::new(0);
static PATCH:AtomicUsize=AtomicUsize::new(0x00ff00ff);
static ANIMATION:AtomicUsize=AtomicUsize::new(0);
unsafe extern "system" fn wndproc(h:HWND,m:u32,w:WPARAM,l:LPARAM)->LRESULT{
 match m{
  WM_APP if w==3=>{SetTimer(h,20,250,None);emit("target_animation_started",json!({"interval_ms":250}));return 0;},
  WM_TIMER if w==20=>{let n=ANIMATION.fetch_add(1,Ordering::SeqCst)+1;SetWindowTextW(GetDlgItem(h,1),wide(&format!("捕获连续性夹具：可见变化序号 {n}；不发送输入。")).as_ptr());return 0;},
  WM_APP if w==1=>{ShowWindow(h,SW_MINIMIZE);emit("target_minimized",json!({"iconic":IsIconic(h)}));return 0;},
  WM_APP if w==2=>{PATCH.store(0x00ffff00,Ordering::SeqCst);ShowWindow(h,SW_SHOWNOACTIVATE);SetWindowPos(h,null_mut(),180,120,1100,650,SWP_NOACTIVATE|SWP_NOZORDER);InvalidateRect(GetDlgItem(h,201),null(),1);emit("target_restored_changed",json!({"iconic":IsIconic(h),"rect":rect(h),"patch_rgb":[0,255,255]}));return 0;},
  WM_APP=>{let p=CreateWindowExW(0,wide("STATIC").as_ptr(),wide("TROOP 焦点故障夹具（仅此进程，短暂显示）").as_ptr(),WS_OVERLAPPEDWINDOW|WS_VISIBLE,600,200,500,200,null_mut(),null_mut(),GetModuleHandleW(null()),null());POPUP.store(p as usize,Ordering::SeqCst);SetForegroundWindow(p);SetTimer(h,9,300,None);emit("focus_pulse_started",json!({"foreground_changed":GetForegroundWindow()==p}));return 0;},
  WM_TIMER if w==9=>{KillTimer(h,9);DestroyWindow(POPUP.swap(0,Ordering::SeqCst) as HWND);SetForegroundWindow(h);emit("focus_pulse_returned",json!({"target_foreground":GetForegroundWindow()==h}));return 0;},
  WM_DRAWITEM=>{let d=&*(l as *const DRAWITEMSTRUCT);if d.CtlID==201{FillRect(d.hDC,&d.rcItem,GetSysColorBrush(COLOR_BTNFACE));let brush=CreateSolidBrush(PATCH.load(Ordering::SeqCst) as u32);FillRect(d.hDC,&RECT{left:10,top:10,right:42,bottom:42},brush);DeleteObject(brush);return 1;}},
  WM_COMMAND=>{match w&0xffff{201=>{let hits=HITS.fetch_add(1,Ordering::SeqCst)+1;SetPropW(h,wide("TroopPrototypeHitCountPlusOne").as_ptr(),(hits+1) as HANDLE);emit("target_hit",json!({"hits":hits}));SetWindowTextW(GetDlgItem(h,1),wide(&format!("独立目标窗口：已命中 {hits} 次；输入来自独立 Rust 控制器。" )).as_ptr());},104=>{SetEvent(STOP.load(Ordering::SeqCst) as HANDLE);emit("target_stop_button",json!({}));},_=>{}}return 0;},
  WM_DESTROY=>{SetEvent(STOP.load(Ordering::SeqCst) as HANDLE);PostQuitMessage(0);return 0;},
  _=>{}
 }DefWindowProcW(h,m,w,l)
}
fn main(){unsafe{
 let a:Vec<_>=std::env::args().collect();if a.len()!=2{return;}
 let stop=OpenEventW(EVENT_MODIFY_STATE,0,wide(&a[1]).as_ptr());if stop.is_null(){return;}STOP.store(stop as usize,Ordering::SeqCst);
 SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
 let instance=GetModuleHandleW(null());let mut cls:WNDCLASSW=zeroed();cls.lpfnWndProc=Some(wndproc);cls.hInstance=instance;cls.lpszClassName=wide("TroopIsolationTarget").leak().as_ptr();cls.hbrBackground=(COLOR_WINDOW+1) as HBRUSH;cls.hCursor=LoadCursorW(null_mut(),IDC_ARROW);RegisterClassW(&cls);
 let h=CreateWindowExW(0,cls.lpszClassName,wide("TROOP 独立控制 — 仅专用目标窗口").as_ptr(),WS_OVERLAPPEDWINDOW,180,120,850,520,null_mut(),null_mut(),instance,null());
 let child=|class:&str,label:&str,id:usize,x,y,w,hgt,style|CreateWindowExW(0,wide(class).as_ptr(),wide(label).as_ptr(),WS_CHILD|WS_VISIBLE|style,x,y,w,hgt,h,id as HMENU,instance,null());
 child("STATIC","独立输入控制演练：只允许点击此窗口的紫红色块。",1,20,20,790,60,0);
 child("BUTTON","",201,20,130,360,70,BS_OWNERDRAW as u32);
 child("BUTTON","立即停止（独立内核事件通道）",104,20,240,770,55,BS_PUSHBUTTON as u32);
 child("STATIC","Ctrl+Shift+F12 由独立控制器处理。\r\n捕获故障不应阻塞停止；没有锁屏或提权操作。",2,20,320,780,75,0);
 ShowWindow(h,SW_SHOW);UpdateWindow(h);SetForegroundWindow(h);
 SetPropW(h,wide("TroopPrototypeHitCountPlusOne").as_ptr(),1usize as HANDLE);
 let hwnd_id=h as usize;std::thread::spawn(move||{for line in std::io::stdin().lock().lines(){let w=match line.ok().as_deref(){Some("focus-pulse")=>Some(0),Some("minimize")=>Some(1),Some("restore-change")=>Some(2),Some("animate")=>Some(3),_=>None};if let Some(w)=w{PostMessageW(hwnd_id as HWND,WM_APP,w,0);}}});
 let mut extended:RECT=zeroed();let hr=DwmGetWindowAttribute(h,DWMWA_EXTENDED_FRAME_BOUNDS as u32,(&mut extended as *mut RECT).cast(),size_of::<RECT>() as u32);
 emit("target_ready",json!({"pid":GetCurrentProcessId(),"hwnd":h as usize,"marker":GetDlgItem(h,201) as usize,"window_rect":rect(h),"marker_rect":rect(GetDlgItem(h,201)),"extended_rect":[extended.left,extended.top,extended.right,extended.bottom],"dwm_hr":hr,"dpi":GetDpiForWindow(h),"integrity":integrity(GetCurrentProcessId())}));
 let mut msg:MSG=zeroed();while GetMessageW(&mut msg,null_mut(),0,0)>0{TranslateMessage(&msg);DispatchMessageW(&msg);}CloseHandle(stop);
}}
