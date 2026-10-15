"""Keep app version names and Android's monotonically increasing code together."""
from pathlib import Path
import argparse,json,re,sys,xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parent.parent
ANDROID='{http://schemas.android.com/apk/res/android}'
def read_json(name):return json.loads((ROOT/name).read_text())
def write_json(name,value):(ROOT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def version_parts(value):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)',value):raise ValueError('版本必须为 MAJOR.MINOR.PATCH，例如 0.1.1')
    return tuple(map(int,value.split('.')))
def check(tag=None):
    package=read_json('package.json');version=package['version'];version_parts(version)
    mobile=read_json('mobile/package.json');lock=read_json('mobile/package-lock.json')
    manifest=ET.parse(ROOT/'android/src/AndroidManifest.xml').getroot()
    versions=[mobile['version'],lock['version'],lock['packages']['']['version'],manifest.get(ANDROID+'versionName')]
    if any(value!=version for value in versions):raise ValueError('package、mobile lock 和 Android versionName 不一致，请使用 bump 命令')
    code=int(manifest.get(ANDROID+'versionCode','0'))
    if code<1:raise ValueError('Android versionCode 必须大于零')
    if tag is not None and tag!='v'+version:raise ValueError('发布标签与版本不一致：'+tag+' / '+version)
    history=ROOT/'releases/manifest.json'
    if tag is not None and history.exists() and any(r['version']==version and r['tag']!=tag for r in json.loads(history.read_text())['artifacts']):raise ValueError('该版本已按历史平台标签交付，请提升版本后创建统一发布标签')
    return {'version':version,'androidVersionCode':code}
def bump(value):
    old=check();new=version_parts(value)
    if new<=version_parts(old['version']):raise ValueError('新版本必须大于当前版本；旧版本标签不重新使用')
    if old['androidVersionCode']>=2100000000:raise ValueError('Android versionCode 已达上限')
    for name in ['package.json','mobile/package.json','mobile/package-lock.json']:
        data=read_json(name);data['version']=value
        if name.endswith('package-lock.json'):data['packages']['']['version']=value
        write_json(name,data)
    path=ROOT/'android/src/AndroidManifest.xml';text=path.read_text()
    text=re.sub(r'android:versionName="[^"]+"','android:versionName="'+value+'"',text,count=1)
    text=re.sub(r'android:versionCode="\d+"','android:versionCode="'+str(old['androidVersionCode']+1)+'"',text,count=1)
    path.write_text(text)
    return check()
parser=argparse.ArgumentParser(description=__doc__)
sub=parser.add_subparsers(dest='command',required=True)
verify=sub.add_parser('check');verify.add_argument('--tag')
update=sub.add_parser('bump');update.add_argument('version')
args=parser.parse_args()
try:print(json.dumps(check(args.tag) if args.command=='check' else bump(args.version),ensure_ascii=False))
except (ValueError,KeyError,OSError,ET.ParseError) as error:print(str(error),file=sys.stderr);sys.exit(1)
