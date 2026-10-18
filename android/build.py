"""Reproducible standalone Android build, using official SDK tools."""
from pathlib import Path
import hashlib
import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import zipfile

ROOT=Path(__file__).resolve().parent
PROJECT=ROOT.parent
VERSION=json.loads((PROJECT/"package.json").read_text(encoding="utf-8"))["version"]
parser=argparse.ArgumentParser()
parser.add_argument("--new-signing-key",action="store_true",help="Create the FIRST identity for a new app; never use for an existing installation")
options=parser.parse_args()
subprocess.run([sys.executable,str(PROJECT/"scripts/versions.py"),"check"],check=True)
BUILD=ROOT/'build'
BUILD.mkdir(exist_ok=True)
TOOLS=ROOT/'.tools'
sdk_roots=[TOOLS/'sdk-extracted']
for variable in ['ANDROID_SDK_ROOT','ANDROID_HOME']:
    if os.environ.get(variable):sdk_roots.append(Path(os.environ[variable]))
def sdk_file(name,version):
    for sdk in sdk_roots:
        for file in sorted(sdk.rglob(name)):
            if version in file.as_posix():return file
    raise RuntimeError('Missing Android SDK '+version+' / '+name+'; run bootstrap.py or set ANDROID_SDK_ROOT')
android_jar=sdk_file('android.jar','android-36')
extension='.exe' if os.name=='nt' else ''
aapt=sdk_file('aapt2'+extension,'36.0.0')
zipalign=sdk_file('zipalign'+extension,'36.0.0')
d8=sdk_file('d8.jar','36.0.0')
signer=sdk_file('apksigner.jar','36.0.0')
libs=list(json.loads((TOOLS/'libraries.json').read_text(encoding="utf-8")).values())
def argument(value):
    # Windows SDK native tools reject some absolute Unicode paths. Keep project
    # files relative to the fixed working directory, without changing sources.
    if isinstance(value,Path):
        try:return value.relative_to(PROJECT).as_posix()
        except ValueError:pass
    return str(value)
def run(args,**kwargs):subprocess.run([argument(a) for a in args],check=True,cwd=PROJECT,**kwargs)
run(['node',PROJECT/'mobile/build.cjs'])
run([aapt,'compile','--dir',ROOT/'src/res','-o',BUILD/'resources.zip'])
run([aapt,'link','-I',android_jar,'--manifest',ROOT/'src/AndroidManifest.xml','-A',BUILD/'assets','--min-sdk-version','26','--target-sdk-version','36','-o',BUILD/'resources.apk',BUILD/'resources.zip'])
def clean_build_folder(folder):
    folder=folder.resolve()
    if BUILD.resolve() not in folder.parents:raise RuntimeError('Build cleanup outside build directory')
    shutil.rmtree(folder,ignore_errors=True);folder.mkdir()
classes=BUILD/'classes';clean_build_folder(classes)
sources=sorted((ROOT/'src/java').rglob('*.java'))
classpath=os.pathsep.join([str(android_jar),*libs])
run(['java','--module','jdk.compiler/com.sun.tools.javac.Main','-encoding','UTF-8','-source','8','-target','8','-classpath',classpath,'-d',classes,*sources])
dex=BUILD/'dex';clean_build_folder(dex)
run(['java','-Xmx2g','-cp',d8,'com.android.tools.r8.D8','--lib',android_jar,'--min-api','26','--output',dex,*sorted(classes.rglob('*.class')),*libs])
unsigned=BUILD/'unsigned.apk'
with zipfile.ZipFile(BUILD/'resources.apk') as res,zipfile.ZipFile(unsigned,'w',zipfile.ZIP_DEFLATED) as out:
    written=set()
    for info in res.infolist():
        if not info.is_dir():out.writestr(info,res.read(info));written.add(info.filename)
    for file in sorted(dex.glob('classes*.dex')):out.writestr(file.name,file.read_bytes());written.add(file.name)
    for library in libs:
        with zipfile.ZipFile(library) as jar:
            for info in jar.infolist():
                name=info.filename
                if info.is_dir() or name.endswith('.class') or name in written or name.startswith('META-INF/versions/') or name=='META-INF/MANIFEST.MF' or name.endswith(('.SF','.RSA','.DSA')):continue
                out.writestr(name,jar.read(info));written.add(name)
run([zipalign,'-f','-p','4',unsigned,BUILD/'aligned.apk'])
private=ROOT/'.private';private.mkdir(mode=0o700,exist_ok=True)
key=private/'riye-update.p12';password=private/'password.txt'
if not key.exists():
    if not options.new_signing_key:raise RuntimeError('请先恢复现有Android更新签名；新建项目首次签名才可使用 --new-signing-key')
    password.write_text(secrets.token_urlsafe(32));password.chmod(0o600)
    env={**os.environ,'RIYE_SIGNING_PASSWORD':password.read_text(encoding="utf-8")}
    run(['keytool','-genkeypair','-keystore',key,'-storetype','PKCS12','-alias','riye','-keyalg','RSA','-keysize','3072','-validity','10000','-dname','CN=Riye Personal App, O=Riye, C=CN','-storepass:env','RIYE_SIGNING_PASSWORD','-keypass:env','RIYE_SIGNING_PASSWORD'],env=env)
    key.chmod(0o600)
env={**os.environ,'RIYE_SIGNING_PASSWORD':password.read_text(encoding="utf-8")}
DIST=PROJECT/'dist';DIST.mkdir(exist_ok=True)
apk=DIST/('Riye-Android-v'+VERSION+'.apk')
run(['java','-jar',signer,'sign','--ks',key,'--ks-key-alias','riye','--ks-pass','env:RIYE_SIGNING_PASSWORD','--key-pass','env:RIYE_SIGNING_PASSWORD','--out',apk,BUILD/'aligned.apk'],env=env)
verification=subprocess.run(['java','-jar',argument(signer),'verify','--verbose','--print-certs',argument(apk)],check=True,capture_output=True,text=True,cwd=PROJECT)
(BUILD/'signature-verification.txt').write_text(verification.stdout,encoding='utf-8')
badging=subprocess.run([argument(aapt),'dump','badging',argument(apk)],check=True,capture_output=True,text=True,encoding='utf-8',cwd=PROJECT)
(BUILD/'apk-badging.txt').write_text(badging.stdout,encoding='utf-8')
assert "minSdkVersion:'26'" in badging.stdout and "targetSdkVersion:'36'" in badging.stdout
assert "uses-permission: name='android.permission.INTERNET'" in badging.stdout
assert badging.stdout.count('uses-permission:')==1
with zipfile.ZipFile(apk) as archive:
    assert archive.testzip() is None
    assert 'assets/bridge.js' in archive.namelist() and 'classes.dex' in archive.namelist()
    assert archive.getinfo('resources.arsc').compress_type==zipfile.ZIP_STORED
    for asset in (BUILD/'assets').iterdir():
        assert archive.read('assets/'+asset.name)==asset.read_bytes(), 'Packaged asset differs: '+asset.name
run([zipalign,'-c','4',apk])
print('Verified APK:',apk.name,apk.stat().st_size,'bytes',hashlib.sha256(apk.read_bytes()).hexdigest())
