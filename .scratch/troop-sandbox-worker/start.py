"""Throwaway supervisor: only own container processes; no Windows desktop access."""
import json, os, pathlib, secrets, signal, subprocess, time
children = []
def launch(args, tool=True):
    if tool:
        args = ['setpriv', '--reuid=1000', '--regid=1000', '--clear-groups',
                '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all',
                '--no-new-privs'] + args
    p = subprocess.Popen(args, env={'PATH':'/usr/local/bin:/usr/bin:/bin',
            'HOME':'/home/troop','DISPLAY':':0','LANG':'C.UTF-8'})
    children.append(p)
    return p
def stop(*_):
    for p in reversed(children):
        if p.poll() is None: p.terminate()
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
for name in ['/workspace','/home/troop','/run/troop-user']:
    pathlib.Path(name).mkdir(parents=True, exist_ok=True)
    os.chown(name,1000,1000)
pathlib.Path('/run/troop-control').mkdir(exist_ok=True)
os.chmod('/run/troop-control',0o700)
password = secrets.token_hex(4)  # VNC's legacy password limit is eight characters.
subprocess.run(['x11vnc','-storepasswd',password,'/run/troop-user/vnc.pass'],check=True,
               stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
os.chown('/run/troop-user/vnc.pass',1000,1000)
pathlib.Path('/run/troop-control/viewer.json').write_text(json.dumps({'password':password}))
os.chmod('/run/troop-control/viewer.json',0o600)
launch(['Xvfb',':0','-screen','0','1280x800x24','-nolisten','tcp','-ac'])
for _ in range(100):
    if pathlib.Path('/tmp/.X11-unix/X0').exists(): break
    time.sleep(.1)
else: raise RuntimeError('Xvfb not ready')
launch(['openbox'])
launch(['xterm','-title','TROOP Sandbox Prototype'])
launch(['x11vnc','-display',':0','-localhost','-rfbport','5900','-forever','-shared',
        '-rfbauth','/run/troop-user/vnc.pass'])
launch(['websockify','--web=/usr/share/novnc','0.0.0.0:6080','127.0.0.1:5900'])
launch(['/usr/local/bin/troop-worker','serve'],tool=False)
while True:
    if any(p.poll() is not None for p in children):
        stop()
    time.sleep(.25)
