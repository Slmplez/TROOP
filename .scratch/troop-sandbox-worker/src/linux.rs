use serde_json::{json, Value};
use std::{fs::{self, OpenOptions}, io::{self, BufRead, BufReader, Read, Write}, os::unix::{fs::PermissionsExt, net::{UnixListener,UnixStream}, process::CommandExt}, process::{Child,Command,Stdio}, sync::{Arc,Mutex,mpsc}, thread, time::{Duration,Instant,SystemTime,UNIX_EPOCH}};
const SOCKET:&str="/run/troop-control/worker.sock";
fn uuid()->String{fs::read_to_string("/proc/sys/kernel/random/uuid").unwrap().trim().to_owned()}
fn now()->u128{SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()}
fn journal(v:&Value){let mut f=OpenOptions::new().create(true).append(true).open("/control/events.jsonl").unwrap();writeln!(f,"{v}").unwrap();f.sync_data().unwrap();}
struct State{authorized:bool,stopped:bool,child:Option<Child>,job:String,lease:Instant}
fn terminate(s:&mut State){if let Some(mut child)=s.child.take(){let group=format!("-{}",child.id());let _=Command::new("/bin/kill").args(["-TERM","--",&group]).status();thread::sleep(Duration::from_millis(150));let _=Command::new("/bin/kill").args(["-KILL","--",&group]).status();let _=child.wait();}}
fn connection(stream:UnixStream,generation:String){
 let run=uuid();let (tx,rx)=mpsc::sync_channel::<Value>(64);let mut writer=stream.try_clone().unwrap();thread::spawn(move||{for e in rx{if writeln!(writer,"{e}").is_err(){break;}}});
 let state=Arc::new(Mutex::new(State{authorized:false,stopped:false,child:None,job:String::new(),lease:Instant::now()+Duration::from_secs(10)}));
 let emit=|event:&str,data:Value|{let v=json!({"event":event,"generation":generation,"run":run,"utc_ms":now(),"data":data});journal(&v);let _=tx.try_send(v);};
 emit("hello",json!({"scope":"Linux prototype; control only; no model provider credentials","lease_ms":10000,"replay":false}));
 let monitor_state=state.clone();let monitor_tx=tx.clone();let monitor_gen=generation.clone();let monitor_run=run.clone();let ended=Arc::new(std::sync::atomic::AtomicBool::new(false));let monitor_end=ended.clone();
 let monitor=thread::spawn(move||{while !monitor_end.load(std::sync::atomic::Ordering::Relaxed){
  {let mut s=monitor_state.lock().unwrap();let status=if let Some(c)=s.child.as_mut(){c.try_wait().unwrap()}else{None};
   if let Some(status)=status{s.child=None;let v=json!({"event":"job_finished","generation":monitor_gen,"run":monitor_run,"utc_ms":now(),"data":{"job":s.job,"exit_code":status.code()}});journal(&v);let _=monitor_tx.try_send(v);}
   if s.authorized&&!s.stopped&&Instant::now()>s.lease{s.authorized=false;s.stopped=true;terminate(&mut s);let v=json!({"event":"stopped","generation":monitor_gen,"run":monitor_run,"utc_ms":now(),"data":{"reason":"lease_expired","job":s.job}});journal(&v);let _=monitor_tx.try_send(v);}}
  thread::sleep(Duration::from_millis(100));
 }});
 for line in BufReader::new(stream).lines(){let Ok(line)=line else{break};if line.len()>32768{break;}let Ok(v)=serde_json::from_str::<Value>(&line)else{emit("rejected",json!({"reason":"invalid_json"}));continue};
  if v["generation"].as_str()!=Some(&generation)||v["run"].as_str()!=Some(&run){emit("rejected",json!({"reason":"stale_identity"}));continue;}
  let mut s=state.lock().unwrap();let op=v["op"].as_str().unwrap_or("");
  if op=="status"{emit("status",json!({"authorized":s.authorized,"stopped":s.stopped,"running":s.child.is_some(),"job":s.job}));continue;}
  if s.stopped{emit("rejected",json!({"reason":"stopped_requires_new_connection"}));continue;}
  match op{
   "grant"=>{s.authorized=true;s.lease=Instant::now()+Duration::from_secs(10);emit("granted",json!({}));},
   "heartbeat"=>{s.lease=Instant::now()+Duration::from_secs(10);},
   "stop"=>{s.authorized=false;s.stopped=true;terminate(&mut s);emit("stopped",json!({"reason":"requested","job":s.job}));},
   "exec" if s.authorized&&s.child.is_none()=>{
    let Some(command)=v["command"].as_str().filter(|s|!s.is_empty()&&s.len()<=8192)else{emit("rejected",json!({"reason":"invalid_command"}));continue};
    // Drop identity, supplementary groups and all capabilities before tools run.
    let child=Command::new("/usr/bin/setpriv").args(["--reuid=1000","--regid=1000","--clear-groups","--bounding-set=-all","--inh-caps=-all","--ambient-caps=-all","--no-new-privs","/bin/sh","-lc",command]).current_dir("/workspace").env_clear().envs([("PATH","/usr/local/bin:/usr/bin:/bin"),("HOME","/home/troop"),("DISPLAY",":0"),("LANG","C.UTF-8")]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0).spawn();
    match child{Ok(mut child)=>{s.job=uuid();emit("job_started",json!({"job":s.job,"pid":child.id(),"tool_uid":1000}));
     for pipe in [child.stdout.take().map(|r|Box::new(r) as Box<dyn Read+Send>),child.stderr.take().map(|r|Box::new(r) as Box<dyn Read+Send>)].into_iter().flatten(){let out=tx.clone();let job=s.job.clone();let gen=generation.clone();let run=run.clone();thread::spawn(move||{let mut pipe=pipe;let mut b=[0u8;4096];let mut total=0;while let Ok(n)=pipe.read(&mut b){if n==0{break;}if total<262144{let _=out.try_send(json!({"event":"output","generation":gen,"run":run,"data":{"job":job,"text":String::from_utf8_lossy(&b[..n])}}));}total+=n;}});}
     s.child=Some(child);
    },Err(e)=>emit("rejected",json!({"reason":"spawn_failed","detail":e.to_string()}))}
   },_=>emit("rejected",json!({"reason":"unauthorized_busy_or_unknown"}))
  }
 }
 ended.store(true,std::sync::atomic::Ordering::Relaxed);{let mut s=state.lock().unwrap();s.authorized=false;s.stopped=true;terminate(&mut s);emit("stopped",json!({"reason":"control_eof","job":s.job}));}let _=monitor.join();
}
pub fn main(){
 if std::env::args().nth(1).as_deref()==Some("connect"){
  let stream=UnixStream::connect(SOCKET).unwrap();let mut input=stream.try_clone().unwrap();thread::spawn(move||{let _=io::copy(&mut io::stdin().lock(),&mut input);let _=input.shutdown(std::net::Shutdown::Write);});let _=io::copy(&mut BufReader::new(stream),&mut io::stdout().lock());return;
 }
 fs::create_dir_all("/run/troop-control").unwrap();fs::set_permissions("/run/troop-control",fs::Permissions::from_mode(0o700)).unwrap();fs::set_permissions("/control",fs::Permissions::from_mode(0o700)).unwrap();
 let generation=uuid();journal(&json!({"event":"worker_boot","generation":generation,"utc_ms":now(),"data":{"automatic_replay":false,"reconciliation":"prior journal preserved; unfinished effects require host reconciliation"}}));
 if std::path::Path::new(SOCKET).exists(){fs::remove_file(SOCKET).unwrap();}let listener=UnixListener::bind(SOCKET).unwrap();fs::set_permissions(SOCKET,fs::Permissions::from_mode(0o600)).unwrap();
 for stream in listener.incoming(){if let Ok(stream)=stream{connection(stream,generation.clone());}}
}
