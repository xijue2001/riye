"""Package directly from official runtime ZIP; verify every unchanged binary."""
from pathlib import Path
import hashlib
import argparse
import json
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / 'package.json').read_text())['version']
RUNTIME_VERSION = '44.7.2'
DIST = ROOT / 'dist'
DIST.mkdir(exist_ok=True)
parser=argparse.ArgumentParser()
parser.add_argument('--source-only',action='store_true')
options=parser.parse_args()
NAME = f'Riye-Windows-x64-v{VERSION}'
PREFIX = NAME + '/'
runtime_zip = ROOT / '.runtime' / f'electron-v{RUNTIME_VERSION}-win32-x64.zip'
windows_zip = DIST / (NAME + '.zip')

if not options.source_only:
    # Stream source members into the deliverable, without intermediate DLL copies.
    with zipfile.ZipFile(runtime_zip) as original, zipfile.ZipFile(windows_zip, 'w', zipfile.ZIP_DEFLATED, compresslevel=5) as output:
        for info in original.infolist():
            name = 'Riye.exe' if info.filename == 'electron.exe' else info.filename
            target = zipfile.ZipInfo(PREFIX + name, date_time=info.date_time)
            target.compress_type = zipfile.ZIP_DEFLATED
            target.external_attr = info.external_attr
            target.file_size = info.file_size
            if info.is_dir():
                output.writestr(target, b'')
                continue
            total = 0
            with original.open(info) as source, output.open(target, 'w') as destination:
                while chunk := source.read(1024 * 1024):
                    destination.write(chunk)
                    total += len(chunk)
            if total != info.file_size:
                raise RuntimeError('Runtime member incomplete: ' + name)
        for directory in ['core', 'desktop', 'renderer']:
            for file in sorted((ROOT / directory).rglob('*')):
                if file.is_file():
                    output.writestr(PREFIX + 'resources/app/' + file.relative_to(ROOT).as_posix(), file.read_bytes())
        output.writestr(PREFIX + 'resources/app/package.json', (ROOT / 'package.json').read_bytes())
        output.writestr(PREFIX + '使用说明.md', (ROOT / 'README.md').read_bytes())
    
    with zipfile.ZipFile(runtime_zip) as original, zipfile.ZipFile(windows_zip) as packaged:
        for info in original.infolist():
            if info.is_dir():
                continue
            name = 'Riye.exe' if info.filename == 'electron.exe' else info.filename
            actual = packaged.getinfo(PREFIX + name)
            if actual.file_size != info.file_size or actual.CRC != info.CRC:
                raise RuntimeError('Packaged runtime differs from official binary: ' + name)
    
source_zip = DIST / f'Riye-Source-v{VERSION}.zip'
with zipfile.ZipFile(source_zip, 'w', zipfile.ZIP_DEFLATED, compresslevel=5) as archive:
    for directory in ['core', 'desktop', 'renderer', 'tests', 'scripts']:
        for file in sorted((ROOT / directory).rglob('*')):
            if file.is_file() and not any(part in {'node_modules','.tools','.private','build','__pycache__'} for part in file.relative_to(ROOT).parts):
                archive.writestr('riye-source/' + file.relative_to(ROOT).as_posix(), file.read_bytes())
    for name in ['package.json', 'README.md']:
        archive.writestr('riye-source/' + name, (ROOT / name).read_bytes())
artifacts=[source_zip] if options.source_only else [windows_zip,source_zip]
for artifact in artifacts:
    with zipfile.ZipFile(artifact) as archive:
        bad = archive.testzip()
        if bad:
            raise RuntimeError('Archive checksum failed: ' + bad)
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    print(artifact.name, artifact.stat().st_size, digest, flush=True)
(DIST / 'SHA256SUMS.txt').write_text('\n'.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name for p in artifacts) + '\n')
if not options.source_only:shutil.copy2(ROOT / 'README.md', DIST / '日页-Windows使用说明.md')

