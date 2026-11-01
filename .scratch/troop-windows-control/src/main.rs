#![windows_subsystem = "windows"]
// THROWAWAY: only controls the test window created by this process.
// Frame-probe coordinates must resolve to our own synthetic marker; no arbitrary HWND/text.
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::VecDeque,
    fs::{self, File},
    io::Write,
    mem::{size_of, zeroed},
    path::PathBuf,
    ptr::{null, null_mut},
    sync::atomic::{AtomicU32, Ordering},
    time::Instant,
};
use windows_sys::Win32::Storage::Xps::PrintWindow;
use windows_sys::Win32::{
    Foundation::*,
    Graphics::{Gdi::*, Dwm::*},
    System::{LibraryLoader::*, RemoteDesktop::*, StationsAndDesktops::*, Threading::*},
    UI::{Controls::DRAWITEMSTRUCT, HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
#[derive(Clone)]
struct Action {
    epoch: u64,
    rect: [i32; 4],
    due: u128,
    kind: &'static str,
    point: Option<[i32;2]>,
}
struct State {
    hwnd: HWND,
    edit: HWND,
    marker: HWND,
    status: HWND,
    grant: bool,
    observed: bool,
    simulated: bool,
    epoch: u64,
    queue: VecDeque<Action>,
    start: Instant,
    clicks: u32,
    log: File,
    out: PathBuf,
    probe: bool,
    step: u8,
    last_rect: [i32; 4],
    os_ok: bool,
    sent: u32,
    hotkey: bool,
    frame_probe: bool,
    frame_ready: bool,
    frame_consumed: bool,
    frame_round: u32,
    frame_observed_at: u128,
    mapping_only: bool,
    frame_armed: bool,
    recovery_probe: bool,
    recovery_stage: u8,
    recovery_observed_at: u128,
    recovery_consumed: bool,
}
static PATCH_COLOR: AtomicU32 = AtomicU32::new(0x00ff00ff);
thread_local! {static STATE:RefCell<Option<State>>=const{RefCell::new(None)};}
fn event(s: &mut State, name: &str, data: Value) {
    let v = json!({"ms":s.start.elapsed().as_millis(),"event":name,"epoch":s.epoch,"grant":s.grant,"observed":s.observed,"queued":s.queue.len(),"data":data});
    writeln!(s.log, "{v}").unwrap();
    s.log.flush().unwrap();
}
unsafe fn rect(h: HWND) -> [i32; 4] {
    let mut r: RECT = zeroed();
    GetWindowRect(h, &mut r);
    [r.left, r.top, r.right, r.bottom]
}
unsafe fn text(h: HWND) -> String {
    let mut b = [0u16; 512];
    let n = GetWindowTextW(h, b.as_mut_ptr(), 512);
    String::from_utf16_lossy(&b[..n as usize])
}
unsafe fn session() -> (bool, Value) {
    let mut p = null_mut();
    let mut len = 0;
    let ok = WTSQuerySessionInformationW(null_mut(), u32::MAX, WTSSessionInfoEx, &mut p, &mut len);
    let query_error = if ok == 0 { GetLastError() } else { 0 };
    let mut state = -1;
    let mut flags = -1;
    let mut id = 0;
    if ok != 0 && len as usize >= size_of::<WTSINFOEXW>() {
        let info = &*(p as *const WTSINFOEXW);
        if info.Level == 1 {
            let l = info.Data.WTSInfoExLevel1;
            state = l.SessionState;
            flags = l.SessionFlags;
            id = l.SessionId;
        }
    }
    if !p.is_null() {
        WTSFreeMemory(p.cast());
    }
    let d = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
    let mut name = [0u16; 80];
    let mut required = 0;
    let default_desktop = if !d.is_null() {
        let ok =
            GetUserObjectInformationW(d, UOI_NAME, name.as_mut_ptr().cast(), 160, &mut required);
        CloseDesktop(d);
        ok != 0
            && String::from_utf16_lossy(&name[..name.iter().position(|x| *x == 0).unwrap_or(80)])
                == "Default"
    } else {
        false
    };
    let remote = GetSystemMetrics(SM_REMOTESESSION) != 0;
    (
        state == WTSActive && flags == WTS_SESSIONSTATE_UNLOCK as i32 && default_desktop && !remote,
        json!({"session_id":id,"state":state,"flags":flags,"default_desktop":default_desktop,"remote":remote,"query_ok":ok,"query_error":query_error,"bytes":len,"expected_bytes":size_of::<WTSINFOEXW>()}),
    )
}
fn invalidate(s: &mut State, reason: &str, revoke: bool) {
    let discarded=s.queue.len();
    s.epoch += 1;
    s.observed = false;
    s.queue.clear();
    if reason != "frame_trial_transition" { s.frame_armed = false; }
    if revoke {
        s.grant = false;
        s.recovery_stage = 0;
    }
    event(s, reason, json!({"pending_discarded":true,"discarded_count":discarded}));
}
unsafe fn render(s: &State) {
    let phase=if s.recovery_probe {match s.recovery_stage{0=>"请开始捕获恢复演练",1=>"等待捕获准备完成，再手动锁屏",2=>"已锁定：旧观测失效",3=>"已解锁：请点重新观察并验证新帧",4=>"正在验证新帧与新点击",5=>"新帧点击已命中：恢复演练完成",_=>"未知阶段"}}else{"仅此窗口；GDI 样本非 WGC"};
    let label=format!("宿主测试窗口 · 授权={} · 新观测={} · epoch={} · 队列={}\r\n命中={} · OS 已插入事件={} · {}\r\n模拟锁定={} · OS 会话可用={} · {}",s.grant,s.observed,s.epoch,s.queue.len(),s.clicks,s.sent,if s.hotkey{"Ctrl+Shift+F12 停止"}else{"快捷键不可用，请用立即停止按钮"},s.simulated,s.os_ok,phase);
    SetWindowTextW(s.status, wide(&label).as_ptr());
}
unsafe fn observe(s: &mut State) {
    let (ok, detail) = session();
    s.os_ok = ok;
    if ok && !s.simulated && GetForegroundWindow() == s.hwnd && IsIconic(s.hwnd) == 0 {
        s.last_rect = rect(s.hwnd);
        s.observed = true;
        event(
            s,
            "observed",
            json!({"rect":s.last_rect,"dpi":GetDpiForWindow(s.hwnd),"session":detail}),
        );
    } else {
        invalidate(s, "observation_blocked", false);
    }
}
unsafe fn enqueue(s: &mut State, kind: &'static str, delay: u128) {
    if !s.grant || !s.observed || s.simulated {
        event(s, "rejected_before_queue", json!({"kind":kind}));
        return;
    }
    s.queue.push_back(Action {
        epoch: s.epoch,
        rect: s.last_rect,
        due: s.start.elapsed().as_millis() + delay,
        kind,
        point: None,
    });
    event(s, "queued_action", json!({"kind":kind,"delay_ms":delay}));
}
unsafe fn dispatch(s: &mut State, a: Action) {
    let (ok, _) = session();
    let mut pid = 0;
    GetWindowThreadProcessId(s.hwnd, &mut pid);
    let modifiers = [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN]
        .iter()
        .any(|k| GetAsyncKeyState(*k as i32) < 0);
    if !ok
        || s.simulated
        || !s.grant
        || !s.observed
        || a.epoch != s.epoch
        || a.rect != rect(s.hwnd)
        || GetForegroundWindow() != s.hwnd
        || pid != GetCurrentProcessId()
        || IsIconic(s.hwnd) != 0
        || modifiers
    {
        invalidate(s, "dispatch_gate_rejected", false);
        return;
    }
    let mut inputs = Vec::<INPUT>::new();
    if a.kind == "click" {
        let r = rect(s.marker);
        let [x,y]=a.point.unwrap_or([(r[0]+r[2])/2,(r[1]+r[3])/2]);
        if x<r[0]||x>=r[2]||y<r[1]||y>=r[3]{invalidate(s,"point_outside_own_marker",false);return;}
        let point = POINT {x,y};
        if WindowFromPoint(point) != s.marker {
            invalidate(s, "target_occluded", false);
            return;
        }
        let x0 = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y0 = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if w <= 1 || h <= 1 {
            invalidate(s, "invalid_layout", false);
            return;
        }
        let x = ((point.x - x0) as i64 * 65535 / (w - 1) as i64) as i32;
        let y = ((point.y - y0) as i64 * 65535 / (h - 1) as i64) as i32;
        for flags in [
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            MOUSEEVENTF_LEFTDOWN,
            MOUSEEVENTF_LEFTUP,
        ] {
            inputs.push(INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: x,
                        dy: y,
                        mouseData: 0,
                        dwFlags: flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
        event(
            s,
            "coordinate_mapping",
            json!({"point":[point.x,point.y],"virtual_rect":[x0,y0,w,h],"normalized":[x,y]}),
        );
    } else {
        // Focus only our synthetic edit control; verify focus before global input.
        SetFocus(s.edit);
        if GetFocus() != s.edit {
            invalidate(s, "focus_failed", false);
            return;
        }
        for unit in "TROOP 中文 ✓".encode_utf16() {
            for flags in [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP] {
                inputs.push(INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: 0,
                            wScan: unit,
                            dwFlags: flags,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                });
            }
        }
    }
    let count = SendInput(
        inputs.len() as u32,
        inputs.as_ptr(),
        size_of::<INPUT>() as i32,
    );
    s.sent += count;
    event(
        s,
        "os_submission",
        json!({"kind":a.kind,"requested":inputs.len(),"inserted":count,"last_error":if count==inputs.len() as u32{0}else{GetLastError()}}),
    );
    if count != inputs.len() as u32 {
        invalidate(s, "partial_or_failed_input_indeterminate", true);
    }
}
unsafe fn extended(h:HWND)->Option<[i32;4]>{
    let mut r:RECT=zeroed();
    let hr=DwmGetWindowAttribute(h,DWMWA_EXTENDED_FRAME_BOUNDS as u32,(&mut r as *mut RECT).cast(),size_of::<RECT>() as u32);
    if hr<0||r.right<=r.left||r.bottom<=r.top{None}else{Some([r.left,r.top,r.right,r.bottom])}
}
unsafe fn frame_tick(s:&mut State){
    if !s.frame_armed{return;}
    if s.frame_round>2{return;}
    if s.frame_consumed {
        if s.mapping_only||s.clicks>=s.frame_round {
            event(s,if s.mapping_only{"frame_mapping_without_input"}else{"frame_click_verified"},json!({"round":s.frame_round,"clicks":s.clicks}));
            s.frame_round+=1;s.frame_ready=false;s.frame_consumed=false;
            invalidate(s,"frame_trial_transition",false);
            if s.frame_round==2{SetWindowPos(s.hwnd,null_mut(),430,230,1100,720,SWP_NOZORDER|SWP_NOACTIVATE);}
        }
        return;
    }
    if !s.frame_ready {
        if !s.os_ok{return;}
        if !s.mapping_only {if GetForegroundWindow()!=s.hwnd{return;}if !s.grant{return;}observe(s);if !s.observed{return;}}
        let Some(bounds)=extended(s.hwnd) else{return;};
        let m=rect(s.marker);s.frame_observed_at=s.start.elapsed().as_millis();
        let data=json!({"round":s.frame_round,"epoch":s.epoch,"window_rect":rect(s.hwnd),"extended_rect":bounds,"marker_rect":m,"patch_rect":[m[0]+10,m[1]+10,m[0]+42,m[1]+42],"dpi":GetDpiForWindow(s.hwnd)});
        fs::write(s.out.join(format!("geometry-{}.json",s.frame_round)),data.to_string()).unwrap();
        event(s,"frame_geometry_ready",data);s.frame_ready=true;return;
    }
    let file=s.out.join(format!("frame-click-{}.json",s.frame_round));
    if !file.exists(){return;}
    s.frame_consumed=true;
    let packet:Value=match fs::read(&file).ok().and_then(|b|if b.len()<8192{serde_json::from_slice(&b).ok()}else{None}){Some(v)=>v,None=>{event(s,"frame_packet_rejected",json!({"reason":"format"}));return;}};
    let coords=packet.get("point").and_then(Value::as_array);
    let point=coords.and_then(|p|if p.len()==2{Some([i32::try_from(p[0].as_i64()?).ok()?,i32::try_from(p[1].as_i64()?).ok()?])}else{None});
    let current_ext=extended(s.hwnd);
    if point.is_none()||packet["epoch"].as_u64()!=Some(s.epoch)||packet["extended_rect"]!=json!(current_ext)||s.start.elapsed().as_millis()-s.frame_observed_at>15000{
        event(s,"frame_packet_rejected",json!({"reason":"stale_or_invalid","packet":packet}));return;
    }
    event(s,"frame_point_received",packet);
    if !s.mapping_only{dispatch(s,Action{epoch:s.epoch,rect:s.last_rect,due:0,kind:"click",point});}
}
unsafe fn recovery_geometry(s: &mut State, after: bool) {
    let Some(bounds)=extended(s.hwnd) else{return;};
    let m=rect(s.marker);
    s.recovery_observed_at=s.start.elapsed().as_millis();
    let data=json!({"epoch":s.epoch,"extended_rect":bounds,"window_rect":rect(s.hwnd),"patch_rect":[m[0]+10,m[1]+10,m[0]+42,m[1]+42],"dpi":GetDpiForWindow(s.hwnd),"patch_rgb":if after{[0,255,255]}else{[255,0,255]},"after_unlock":after});
    fs::write(s.out.join(if after{"recovery-after.json"}else{"recovery-before.json"}),data.to_string()).unwrap();
    event(s,"recovery_geometry_ready",data);
}
unsafe fn recovery_tick(s: &mut State) {
    if s.recovery_stage!=4{return;}
    if s.recovery_consumed {
        if s.clicks>0{s.recovery_stage=5;event(s,"recovery_click_verified",json!({"clicks":s.clicks}));}
        return;
    }
    let file=s.out.join("recovery-click.json");
    if !file.exists(){return;}
    s.recovery_consumed=true;
    let packet:Value=match fs::read(&file).ok().and_then(|b|if b.len()<8192{serde_json::from_slice(&b).ok()}else{None}){Some(v)=>v,None=>{event(s,"recovery_packet_rejected",json!({"reason":"format"}));return;}};
    let point=packet.get("point").and_then(Value::as_array).and_then(|p|if p.len()==2{Some([i32::try_from(p[0].as_i64()?).ok()?,i32::try_from(p[1].as_i64()?).ok()?])}else{None});
    if point.is_none()||packet["epoch"].as_u64()!=Some(s.epoch)||packet["extended_rect"]!=json!(extended(s.hwnd))||s.start.elapsed().as_millis()-s.recovery_observed_at>15000{
        event(s,"recovery_packet_rejected",json!({"reason":"stale_or_invalid"}));return;
    }
    event(s,"recovery_new_point_received",packet);
    dispatch(s,Action{epoch:s.epoch,rect:s.last_rect,due:0,kind:"click",point});
}
unsafe fn capture(s: &mut State) {
    // Render ONLY our synthetic client using WM_PRINT/PrintWindow, not a desktop screenshot.
    let mut r: RECT = zeroed();
    GetClientRect(s.hwnd, &mut r);
    let w = r.right;
    let h = r.bottom;
    let dc = GetDC(s.hwnd);
    let mem = CreateCompatibleDC(dc);
    let bmp = CreateCompatibleBitmap(dc, w, h);
    let old = SelectObject(mem, bmp);
    let result = PrintWindow(s.hwnd, mem, 1);
    SelectObject(mem, old);
    let mut info: BITMAPINFO = zeroed();
    info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = w;
    info.bmiHeader.biHeight = -h;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    let mut pixels = vec![0u8; (w * h * 4) as usize];
    let rows = GetDIBits(
        mem,
        bmp,
        0,
        h as u32,
        pixels.as_mut_ptr().cast(),
        &mut info,
        DIB_RGB_COLORS,
    );
    if result != 0 && rows != 0 {
        let mut bytes = Vec::new();
        bytes.extend(b"BM");
        bytes.extend((54 + pixels.len() as u32).to_le_bytes());
        bytes.extend([0u8; 4]);
        bytes.extend(54u32.to_le_bytes());
        bytes.extend(40u32.to_le_bytes());
        bytes.extend(w.to_le_bytes());
        bytes.extend((-h).to_le_bytes());
        bytes.extend(1u16.to_le_bytes());
        bytes.extend(32u16.to_le_bytes());
        bytes.extend([0u8; 24]);
        bytes.extend(pixels);
        fs::write(s.out.join("synthetic-window.bmp"), bytes).unwrap();
    }
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(s.hwnd, dc);
    event(
        s,
        "synthetic_capture",
        json!({"backend":"PrintWindow-GDI-client-only","width":w,"height":h,"print_return":result,"rows":rows,"not_wgc":true}),
    );
}
unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg==WM_DRAWITEM {
        let item=&*(lp as *const DRAWITEMSTRUCT);
        if item.CtlID==201 {
            FillRect(item.hDC,&item.rcItem,GetSysColorBrush(COLOR_BTNFACE));
            let patch=RECT{left:10,top:10,right:42,bottom:42};
            let brush=CreateSolidBrush(PATCH_COLOR.load(Ordering::Relaxed));FillRect(item.hDC,&patch,brush);DeleteObject(brush);
            let mut label=RECT{left:52,top:10,right:item.rcItem.right-8,bottom:52};
            DrawTextW(item.hDC,wide("图像定位色块 / 命中计数").as_ptr(),-1,&mut label,DT_LEFT|DT_VCENTER|DT_SINGLELINE);
            return 1;
        }
    }
    if msg == WM_DESTROY {
        PostQuitMessage(0);
        return 0;
    }
    // PrintWindow sends reentrant paint messages: never borrow State for unrelated messages.
    if ![
        WM_COMMAND,
        WM_TIMER,
        WM_HOTKEY,
        WM_WTSSESSION_CHANGE,
        WM_DISPLAYCHANGE,
        WM_DPICHANGED,
    ]
    .contains(&msg)
    {
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
    STATE.with(|cell|{let Ok(mut v)=cell.try_borrow_mut() else{return;};let Some(s)=v.as_mut() else{return;};
 match msg{
 WM_COMMAND=>{match wp&0xffff{
 101=>{s.epoch+=1;s.grant=true;observe(s);event(s,"task_granted",json!({"scope":"own-test-window"}));},
 102=>enqueue(s,"click",1500),103=>enqueue(s,"unicode",1500),104=>invalidate(s,"user_stop",true),
 105=>{s.simulated=true;invalidate(s,"simulated_lock",false);},106=>{s.simulated=false;invalidate(s,"simulated_unlock_requires_observation",false);},
 107=>{invalidate(s,"simulated_stale_frame",false);},108=>observe(s),109=>capture(s),
 110=>{invalidate(s,"probe_reset",true);s.simulated=false;s.clicks=0;s.sent=0;s.step=0;s.start=Instant::now();s.probe=true;SetWindowTextW(s.edit,wide("").as_ptr());},
 111=>{invalidate(s,"lock_trial_reset",true);s.grant=true;observe(s);event(s,"task_granted",json!({"scope":"own-test-window","exercise":"real-lock-with-queued-action"}));enqueue(s,"click",60000);},
 112=>{if s.recovery_probe&&s.recovery_stage==0{invalidate(s,"recovery_start",true);s.grant=true;observe(s);if s.observed{s.clicks=0;s.recovery_stage=1;PATCH_COLOR.store(0x00ff00ff,Ordering::Relaxed);InvalidateRect(s.marker,null(),1);recovery_geometry(s,false);}}},
 113=>{if s.recovery_probe&&s.recovery_stage==3&&s.grant{invalidate(s,"recovery_manual_reobserve",false);observe(s);if s.observed{s.recovery_stage=4;s.recovery_consumed=false;recovery_geometry(s,true);}}},
 201=>{s.clicks+=1;event(s,"target_click_received",json!({"clicks":s.clicks}));},_=>{}
 }},
 WM_HOTKEY=>invalidate(s,"emergency_hotkey",true),
 WM_WTSSESSION_CHANGE=>{invalidate(s,"wts_event",false);event(s,"wts_detail",json!({"change":wp,"session":lp}));if s.recovery_probe&&s.grant{if wp==WTS_SESSION_LOCK as usize&&s.recovery_stage>0&&s.recovery_stage<5{s.recovery_stage=2;}else if wp==WTS_SESSION_UNLOCK as usize&&s.recovery_stage==2{s.recovery_stage=3;PATCH_COLOR.store(0x00ffff00,Ordering::Relaxed);InvalidateRect(s.marker,null(),1);event(s,"recovery_awaiting_manual_observation",json!({"new_patch_rgb":[0,255,255]}));}}},
 WM_DISPLAYCHANGE|WM_DPICHANGED=>invalidate(s,"display_changed",false),
 WM_TIMER=>{
  let (ok,_)=session();if !ok&&s.os_ok{invalidate(s,"session_unavailable",false);}s.os_ok=ok;
  if s.observed&&(GetForegroundWindow()!=s.hwnd||rect(s.hwnd)!=s.last_rect){invalidate(s,"focus_or_geometry_changed",false);}
  let now=s.start.elapsed().as_millis();
  if s.frame_probe {frame_tick(s);}
  if s.recovery_probe {recovery_tick(s);}
  if s.probe {let threshold=[300,600,1000,1500,2000,2500,3000,3500,4100,4700,5300,5900,6500];
   if (s.step as usize)<threshold.len()&&now>=threshold[s.step as usize]{match s.step{
    0=>enqueue(s,"click",0),
    1=>{s.grant=true;s.epoch+=1;observe(s);event(s,"probe_grant",json!({}));},
    2=>enqueue(s,"click",0),3=>enqueue(s,"unicode",0),
    4=>{event(s,"target_text_observed",json!({"text":text(s.edit)}));capture(s);},
    5=>{enqueue(s,"click",200);invalidate(s,"probe_stop",true);},
    6=>enqueue(s,"click",0),
    7=>{s.grant=true;observe(s);enqueue(s,"click",500);s.simulated=true;invalidate(s,"simulated_lock",false);},
    8=>{s.simulated=false;invalidate(s,"simulated_unlock_requires_observation",false);enqueue(s,"click",0);},
    9=>{observe(s);enqueue(s,"click",200);invalidate(s,"simulated_stale_frame",false);},
    10=>{observe(s);enqueue(s,"click",0);},
    11=>{event(s,"probe_summary",json!({"clicks":s.clicks,"text":text(s.edit),"inserted_events":s.sent,"real_lock_tested":false,"uipi_tested":false,"multi_monitor_tested":false}));},
    12=>{DestroyWindow(s.hwnd);},_=>{}
   }s.step+=1;}
  }
  if s.queue.front().map(|a|a.due<=now).unwrap_or(false){let a=s.queue.pop_front().unwrap();dispatch(s,a);}
 },_=>{}
 }render(s);});
    0
}
unsafe fn child(
    parent: HWND,
    class: &str,
    label: &str,
    id: usize,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    style: u32,
) -> HWND {
    CreateWindowExW(
        0,
        wide(class).as_ptr(),
        wide(label).as_ptr(),
        WS_VISIBLE | WS_CHILD | style,
        x,
        y,
        w,
        h,
        parent,
        id as HMENU,
        GetModuleHandleW(null()),
        null(),
    )
}
fn main() {
    unsafe {
        let args: Vec<_> = std::env::args().collect();
        let lock_only=args.iter().any(|a|a=="--lock-probe");
        let recovery_only=args.iter().any(|a|a=="--recovery-probe");
        let out = PathBuf::from(args.get(1).expect("output directory required"));
        fs::create_dir_all(&out).unwrap();
        let dpi_ok = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let instance = GetModuleHandleW(null());
        let cname = wide("TroopHostControlPrototype");
        let mut cls: WNDCLASSW = zeroed();
        cls.lpfnWndProc = Some(wndproc);
        cls.hInstance = instance;
        cls.lpszClassName = cname.as_ptr();
        cls.hbrBackground = (COLOR_WINDOW + 1) as HBRUSH;
        cls.hCursor = LoadCursorW(null_mut(), IDC_ARROW);
        assert_ne!(RegisterClassW(&cls), 0);
        let hwnd = CreateWindowExW(
            0,
            cname.as_ptr(),
            wide("TROOP 宿主控制原型 — 仅专用测试窗口").as_ptr(),
            WS_OVERLAPPEDWINDOW,
            80,
            80,
            920,
            650,
            null_mut(),
            null_mut(),
            instance,
            null(),
        );
        assert!(!hwnd.is_null());
        let status = child(hwnd, "STATIC", "尚未授权", 1, 20, 15, 860, 85, 0);
        if !lock_only && !recovery_only { for (i, (label, id)) in [
            ("授权并观察", 101),
            ("延迟点击标记", 102),
            ("延迟输入中文", 103),
            ("立即停止", 104),
            ("模拟锁定", 105),
            ("模拟解锁", 106),
            ("使旧帧失效", 107),
            ("重新观察", 108),
            ("保存测试窗图", 109),
        ]
        .iter()
        .enumerate()
        {
            child(
                hwnd,
                "BUTTON",
                label,
                *id,
                20 + (i % 3) as i32 * 285,
                115 + (i / 3) as i32 * 48,
                270,
                38,
                BS_PUSHBUTTON as u32,
            );
        }
        }
        let marker = child(
            hwnd,
            "BUTTON",
            "专用命中标记（计数）",
            201,
            20,
            280,
            360,
            65,
            BS_OWNERDRAW as u32,
        );
        if !lock_only && !recovery_only { child(
            hwnd,
            "BUTTON",
            "运行 7 秒受控演练",
            110,
            440,
            280,
            360,
            65,
            BS_PUSHBUTTON as u32,
        ); }
        let edit = child(
            hwnd,
            "EDIT",
            "",
            202,
            20,
            365,
            830,
            44,
            WS_BORDER | ES_AUTOHSCROLL as u32,
        );
        child(hwnd,"STATIC",if recovery_only{"1. 开始后等待捕获面板显示“已准备，可手动锁屏”。\r\n2. 手动锁屏并解锁；旧输入不会重放。\r\n3. 返回此窗，点击“重新观察并验证新帧”，保持前台数秒。\r\n只点击此窗口自身色块；颜色在解锁后变为青色，用来排除旧帧。"}else if lock_only {"1. 点击上方开始按钮，确认授权=true、队列=1。\r\n2. 在 60 秒内手动锁屏，然后解锁。\r\n3. 解锁后不要点任何按钮，回聊天回复“已完成”。\r\n若没有锁屏且目标一直在前台，60 秒后最多点击自身标记一次。"}else{"试用：授权 → 延迟动作 → 立即停止；或模拟锁定后解锁，旧动作不会重放。\r\n切换到其他窗口会暂停；回来后需重新观察。按钮“模拟”不改变 Windows 锁屏。\r\n此原型不测试 UAC，不操作其他软件；短动作已进入 OS 后无法撤回。"},203,20,430,850,100,0);
        if !recovery_only {child(hwnd,"BUTTON",if lock_only{"开始锁屏演练：授权并排队 60 秒"}else{"锁屏演练：授权并排队 60 秒"},111,20,if lock_only{115}else{540},830,if lock_only{60}else{36},BS_PUSHBUTTON as u32);}
        if lock_only {child(hwnd,"BUTTON","停止 / 取消这次演练",104,20,195,830,48,BS_PUSHBUTTON as u32);}
        if recovery_only {for (label,id,y) in [("开始捕获恢复演练",112,115),("重新观察并验证新帧（解锁后）",113,163),("立即停止",104,211)]{child(hwnd,"BUTTON",label,id,20,y,830,38,BS_PUSHBUTTON as u32);}}
        let (ok, detail) = session();
        let log = File::create(out.join("events.jsonl")).unwrap();
        let mut s = State {
            hwnd,
            edit,
            marker,
            status,
            grant: false,
            observed: false,
            simulated: false,
            epoch: 0,
            queue: VecDeque::new(),
            start: Instant::now(),
            clicks: 0,
            log,
            out,
            probe: args.iter().any(|a| a == "--probe"),
            step: 0,
            last_rect: rect(hwnd),
            os_ok: ok,
            sent: 0,
            hotkey: false,
            frame_probe: args.iter().any(|a|a=="--frame-probe"),
            frame_ready:false,
            frame_consumed:false,
            frame_round:1,
            frame_observed_at:0,
            mapping_only:args.iter().any(|a|a=="--mapping-only"),
            frame_armed:args.iter().any(|a|a=="--frame-probe"),
            recovery_probe:recovery_only,
            recovery_stage:0,
            recovery_observed_at:0,
            recovery_consumed:false,
        };
        event(
            &mut s,
            "startup",
            json!({"pid":GetCurrentProcessId(),"hwnd":hwnd as usize,"dpi_context_set":dpi_ok,"dpi":GetDpiForWindow(hwnd),"monitor_count":GetSystemMetrics(SM_CMONITORS),"virtual_rect":[GetSystemMetrics(SM_XVIRTUALSCREEN),GetSystemMetrics(SM_YVIRTUALSCREEN),GetSystemMetrics(SM_CXVIRTUALSCREEN),GetSystemMetrics(SM_CYVIRTUALSCREEN)],"session":detail}),
        );
        let registered = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        let hotkey = RegisterHotKey(
            hwnd,
            1,
            MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT,
            VK_F12 as u32,
        );
        s.hotkey = hotkey != 0;
        if s.frame_probe&&!s.mapping_only{s.grant=true;event(&mut s,"frame_probe_launch_grant",json!({"scope":"own-test-window","revoked_on_stop":true}));}
        event(
            &mut s,
            "notifications",
            json!({"wts_registered":registered,"stop_hotkey_registered":hotkey}),
        );
        STATE.with(|c| *c.borrow_mut() = Some(s));
        ShowWindow(hwnd, SW_SHOW);
        ShowWindow(hwnd, SW_RESTORE);
        UpdateWindow(hwnd);
        SetForegroundWindow(hwnd);
        STATE.with(|c|{let mut v=c.borrow_mut();let s=v.as_mut().unwrap();event(s,"window_visibility",json!({"visible":IsWindowVisible(hwnd),"iconic":IsIconic(hwnd),"foreground_owned":GetForegroundWindow()==hwnd}));});
        SetTimer(hwnd, 1, 40, None);
        let mut msg: MSG = zeroed();
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        WTSUnRegisterSessionNotification(hwnd);
        UnregisterHotKey(hwnd, 1);
    }
}
