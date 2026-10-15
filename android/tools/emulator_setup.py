"""Optional headless API 36 smoke-test environment; not required to build."""
from pathlib import Path
import concurrent.futures,hashlib,urllib.request,xml.etree.ElementTree as ET,zipfile
ROOT=Path(__file__).resolve().parent.parent
DEST=ROOT/'.tools/emulator-qa'
DEST.mkdir(parents=True,exist_ok=True)
BASE='https://dl.google.com/android/repository/'
def task(url,wanted):
    with urllib.request.urlopen(url,timeout=60) as r:doc=ET.fromstring(r.read())
    for item in doc.iter('remotePackage'):
        if item.get('path')!=wanted:continue
        if item.find('channelRef') is not None and item.find('channelRef').get('ref')!='channel-0':continue
        for a in item.findall('archives/archive'):
            if a.findtext('host-os') not in [None,'linux']:continue
            name=a.findtext('complete/url');expected=a.findtext('complete/checksum');archive=DEST/name
            if not archive.exists():
                digest=hashlib.sha1()
                with urllib.request.urlopen(url.rsplit('/',1)[0]+'/'+name,timeout=60) as src,archive.with_suffix('.part').open('wb') as out:
                    while chunk:=src.read(1024*1024):out.write(chunk);digest.update(chunk)
                if digest.hexdigest()!=expected:raise RuntimeError('Invalid emulator download')
                archive.with_suffix('.part').replace(archive)
            with zipfile.ZipFile(archive) as z:
                for info in z.infolist():
                    if info.is_dir():continue
                    target=DEST/info.filename;target.parent.mkdir(parents=True,exist_ok=True)
                    with z.open(info) as src,target.open('wb') as out:
                        while chunk:=src.read(1024*1024):out.write(chunk)
                    assert target.stat().st_size==info.file_size
                    perm=info.external_attr>>16&0o777
                    if perm:target.chmod(perm)
            print('Verified smoke-test tools:',wanted,flush=True);return
    raise RuntimeError('No stable matching emulator package')
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(lambda q:task(*q),[(BASE+'repository2-1.xml','emulator'),(BASE+'sys-img/android/sys-img2-1.xml','system-images;android-36;default;x86_64')]))
platform=DEST/'platform-tools'
if not platform.exists():platform.symlink_to(ROOT/'.tools/sdk-extracted/platform-tools/platform-tools',target_is_directory=True)
(DEST/'platforms').mkdir(exist_ok=True)
avd=DEST/'avd/RiyeQA.avd';avd.mkdir(parents=True,exist_ok=True)
(avd/'config.ini').write_text('avd.ini.encoding=UTF-8\nAvdId=RiyeQA\nabi.type=x86_64\nhw.cpu.arch=x86_64\nhw.cpu.ncore=4\nhw.ramSize=2048\nhw.lcd.width=432\nhw.lcd.height=960\nhw.lcd.density=180\nhw.keyboard=yes\nhw.gpu.enabled=yes\nhw.gpu.mode=swiftshader_indirect\nimage.sysdir.1='+str(DEST/'x86_64')+'/\ntag.id=default\ntag.display=Default\ndisk.dataPartition.size=2048M\n')
(DEST/'avd/RiyeQA.ini').write_text('avd.ini.encoding=UTF-8\npath='+str(avd)+'\ntarget=android-36\n')
print('AVD prepared at',avd)
