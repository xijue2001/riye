"""Fetch verified official Android platform/build tools and pinned JVM libraries."""
from pathlib import Path
import concurrent.futures
import hashlib
import json
import os
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT=Path(__file__).resolve().parent.parent
TOOLS=ROOT/'.tools'
TOOLS.mkdir(parents=True,exist_ok=True)
REPO='https://dl.google.com/android/repository/'
MAVEN='https://repo.maven.apache.org/maven2/'
def fetch(url):
    with urllib.request.urlopen(url,timeout=60) as r:return r.read()
def download(url,target,expected=None,algorithm='sha256'):
    target.parent.mkdir(parents=True,exist_ok=True)
    if target.exists() and (not expected or hashlib.new(algorithm,target.read_bytes()).hexdigest()==expected):return
    partial=target.with_suffix('.partial')
    digest=hashlib.new(algorithm)
    with urllib.request.urlopen(url,timeout=90) as src,partial.open('wb') as dst:
        while chunk:=src.read(1024*1024):dst.write(chunk);digest.update(chunk)
    if expected and digest.hexdigest()!=expected:raise RuntimeError('Download checksum mismatch: '+target.name)
    partial.replace(target)
def unpack(archive,destination):
    destination.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            if info.is_dir():continue
            target=destination/info.filename
            target.parent.mkdir(parents=True,exist_ok=True)
            with z.open(info) as src,target.open('wb') as dst:
                while chunk:=src.read(1024*1024):dst.write(chunk)
            if target.stat().st_size!=info.file_size:raise RuntimeError('Extraction incomplete: '+info.filename)
            permissions=(info.external_attr>>16)&0o777
            if permissions:target.chmod(permissions)
repo=ET.fromstring(fetch(REPO+'repository2-1.xml'))
packages=[]
for item in repo.iter('remotePackage'):
    package=item.get('path')
    if package not in ['platforms;android-36','build-tools;36.0.0','platform-tools']:continue
    for archive in item.findall('archives/archive'):
        if archive.findtext('host-os') not in [None,'linux']:continue
        url=archive.findtext('complete/url')
        if package=='platforms;android-36' and '-ext' in url:continue
        packages.append((package,url,archive.findtext('complete/checksum')))
def sdk_task(item):
    package,name,checksum=item;dest=TOOLS/'downloads'/name
    download(REPO+name,dest,checksum,'sha1');folder=TOOLS/'sdk-extracted'/package.replace(';','-')
    unpack(dest,folder);print('Verified SDK',package,flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:list(pool.map(sdk_task,packages))

libraries={}
NS={'m':'http://maven.apache.org/POM/4.0.0'}
def resolve(group,artifact,version):
    key=f'{group}:{artifact}:{version}'
    if key in libraries:return
    base=MAVEN+group.replace('.','/')+'/'+artifact+'/'+version+'/'+artifact+'-'+version
    pom=ET.fromstring(fetch(base+'.pom'))
    jar=TOOLS/'jars'/(artifact+'-'+version+'.jar')
    try:expected=fetch(base+'.jar.sha256').decode().split()[0];alg='sha256'
    except Exception:expected=fetch(base+'.jar.sha1').decode().split()[0];alg='sha1'
    download(base+'.jar',jar,expected,alg);libraries[key]=str(jar)
    for d in pom.findall('m:dependencies/m:dependency',NS):
        scope=d.findtext('m:scope','compile',NS)
        if scope not in ['compile','runtime'] or d.findtext('m:optional','false',NS)=='true':continue
        dg=d.findtext('m:groupId',namespaces=NS);da=d.findtext('m:artifactId',namespaces=NS);dv=d.findtext('m:version',namespaces=NS)
        if not dv or '$' in dv:raise RuntimeError('Unresolved dependency '+str((dg,da,dv)))
        resolve(dg,da,dv)
resolve('com.squareup.okhttp3','okhttp-jvm','5.5.0')
# JVM-only JSON implementation for filesystem/protocol fixture tests.
base=MAVEN+'org/json/json/20250517/json-20250517'
jsonjar=TOOLS/'json-test.jar'
try:expected=fetch(base+'.jar.sha256').decode().split()[0];algorithm='sha256'
except Exception:expected=fetch(base+'.jar.sha1').decode().split()[0];algorithm='sha1'
download(base+'.jar',jsonjar,expected,algorithm)
(TOOLS/'libraries.json').write_text(json.dumps(libraries,indent=2))
print('Verified runtime libraries:',len(libraries),flush=True)
