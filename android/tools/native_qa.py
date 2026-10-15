"""Install the release APK and signed instrumentation in an API36 emulator.
Requires emulator_setup.py. Keeps emulator, adb and mock DAV in one environment.
"""
from pathlib import Path
import os,subprocess,time,threading,http.server,json,zipfile,shutil,signal
ROOT=Path(__file__).resolve().parent.parent
PROJECT=ROOT.parent
TOOLS=ROOT/'.tools'
QA=TOOLS/'emulator-qa'
BUILD=ROOT/'build'
BUILD.mkdir(exist_ok=True)
sdk=TOOLS/'sdk-extracted'
androidjar=next(sdk.rglob('android.jar'));aapt=next(sdk.rglob('aapt2'));d8=next(sdk.rglob('d8.jar'));signer=next(sdk.rglob('apksigner.jar'));adb=str(next(sdk.rglob('adb')))
def run(args,**kwargs):return subprocess.run([str(x) for x in args],check=True,**kwargs)
classes=BUILD/'qa-classes';shutil.rmtree(classes,ignore_errors=True);classes.mkdir()
run(['java','--module','jdk.compiler/com.sun.tools.javac.Main','-classpath',androidjar,'-d',classes,ROOT/'tests/Smoke.java'])
run([aapt,'link','-I',androidjar,'--manifest',ROOT/'tests/AndroidManifest.xml','-o',BUILD/'qa-res.apk'])
dex=BUILD/'qa-dex';shutil.rmtree(dex,ignore_errors=True);dex.mkdir()
run(['java','-cp',d8,'com.android.tools.r8.D8','--lib',androidjar,'--min-api','26','--output',dex,*classes.rglob('*.class')])
with zipfile.ZipFile(BUILD/'qa-res.apk') as src,zipfile.ZipFile(BUILD/'qa-unsigned.apk','w') as dst:
 for info in src.infolist():dst.writestr(info,src.read(info))
 for f in dex.glob('classes*.dex'):dst.writestr(f.name,f.read_bytes())
env={**os.environ,'RIYE_SIGNING_PASSWORD':(ROOT/'.private/password.txt').read_text()}
run(['java','-jar',signer,'sign','--ks',ROOT/'.private/riye-update.p12','--ks-key-alias','riye','--ks-pass','env:RIYE_SIGNING_PASSWORD','--out',BUILD/'qa.apk',BUILD/'qa-unsigned.apk'],env=env)
files={};dirs={'/'}
class Dav(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def send(self,status,body=b''):
  self.send_response(status);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def do_PROPFIND(self):
  if self.path not in dirs:self.send(404);return
  xml='<d:multistatus xmlns:d="DAV:"><d:response><d:href>'+self.path+'</d:href></d:response>'
  if self.headers.get('Depth')!='0':
   for f in files:
    if f.startswith(self.path) and '/' not in f[len(self.path):]:xml+='<d:response><d:href>'+f+'</d:href></d:response>'
  self.send(207,(xml+'</d:multistatus>').encode())
 def do_MKCOL(self):
  status=405 if self.path in dirs else 201;dirs.add(self.path);self.send(status)
 def do_PUT(self):
  data=self.rfile.read(int(self.headers.get('Content-Length','0')))
  if self.path in files and self.headers.get('If-None-Match')=='*':self.send(412);return
  files[self.path]=data;self.send(201)
 def do_GET(self):self.send(200,files[self.path]) if self.path in files else self.send(404)
 def do_DELETE(self):files.pop(self.path,None);self.send(204)
server=http.server.ThreadingHTTPServer(('0.0.0.0',8765),Dav);threading.Thread(target=server.serve_forever,daemon=True).start()
# A fresh AVD avoids stale snapshots and locks from interrupted test runs.
avdhome=QA/'native-avd';avd=avdhome/'RiyeNativeQA.avd';avd.mkdir(parents=True,exist_ok=True)
(avd/'config.ini').write_text((QA/'avd/RiyeQA.avd/config.ini').read_text().replace('RiyeQA','RiyeNativeQA'))
(avdhome/'RiyeNativeQA.ini').write_text('avd.ini.encoding=UTF-8\npath='+str(avd)+'\ntarget=android-36\n')
env={**os.environ,'ANDROID_AVD_HOME':str(avdhome),'ANDROID_SDK_ROOT':str(QA),'ANDROID_HOME':str(QA)}
log=(BUILD/'native-emulator.log').open('w')
run([adb,'start-server'],env=env)
emulator=subprocess.Popen([str(QA/'emulator/emulator'),'-avd','RiyeNativeQA','-no-window','-no-audio','-no-boot-anim','-no-snapshot','-accel',os.environ.get('RIYE_QA_ACCEL','auto' if Path('/dev/kvm').exists() else 'off'),'-gpu','swiftshader','-cores','1','-feature','-Vulkan','-crash-report-mode','disabled','-camera-back','none','-camera-front','none','-port','5554'],env=env,stdout=log,stderr=log,start_new_session=True)
def adb_run(*args,**kwargs):return subprocess.run([adb,'-s','emulator-5554',*args],env=env,**kwargs)
try:
 start=time.monotonic();last=0
 while time.monotonic()-start<900:
  if emulator.poll() is not None:raise RuntimeError('Emulator exited; see native-emulator.log')
  try:output=adb_run('shell','getprop','sys.boot_completed',capture_output=True,text=True,timeout=30)
  except subprocess.TimeoutExpired:
   print('ADB still starting; retrying boot check.',flush=True);continue
  if output.returncode==0 and output.stdout.strip()=='1':break
  if time.monotonic()-start>last:print('Waiting for API36 startup:',round(time.monotonic()-start),'s',flush=True);last+=30;(BUILD/'native-boot-status.txt').write_text(output.stdout+'\n'+output.stderr)
  time.sleep(2)
 else:raise RuntimeError('Emulator did not boot within smoke-test limit')
 print('Android 16 booted; installing release APK.',flush=True)
 for package in [PROJECT/('dist/Riye-Android-v'+json.loads((PROJECT/'package.json').read_text())['version']+'.apk'),BUILD/'qa.apk']:
  adb_run('install','-r',str(package),check=True,timeout=90)
 adb_run('shell','input','keyevent','82',timeout=20)
 result=adb_run('shell','am','instrument','-w','dev.riye.qa/dev.riye.qa.Smoke',capture_output=True,text=True,timeout=300)
 (BUILD/'native-smoke-result.txt').write_text(result.stdout+result.stderr)
 print(result.stdout,result.stderr,flush=True)
 assert '"ok":true' in result.stdout,'Native smoke test failed'
 assert any('/assets/' in name for name in files) and any('/revisions/' in name for name in files),'No native DAV uploads'
 run([adb,'-s','emulator-5554','shell','am','start','-n','dev.riye.app/.MainActivity'],env=env,timeout=30)
 time.sleep(3)
 (BUILD/'native-logcat.txt').write_text(adb_run('logcat','-d',capture_output=True,text=True,timeout=30).stdout)
 with (PROJECT/'.qa-native-android.png').open('wb') as out:adb_run('exec-out','screencap','-p',stdout=out,check=True,timeout=30)
 print('PASS: actual release APK installs and starts on Android16; native private storage, KeyStore, WebView bridge, original photo and OkHttp WebDAV transfer verified.',flush=True)
finally:
 try:os.killpg(emulator.pid,signal.SIGTERM)
 except ProcessLookupError:pass
 try:emulator.wait(timeout=15)
 except subprocess.TimeoutExpired:
  try:os.killpg(emulator.pid,signal.SIGKILL)
  except ProcessLookupError:pass
 server.shutdown();log.close()
