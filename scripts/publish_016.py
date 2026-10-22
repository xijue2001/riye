"""Publish reviewed 0.1.6 bytes without exposing the Android update key.

The signed APK lives in an unreferenced public Git blob, outside source history.
Never change an existing tag or replace assets on an already published release.
"""
from pathlib import Path
import argparse
import base64
import datetime
import hashlib
import json
import os
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
REPO = 'xijue2001/riye'
BASE = 'https://api.github.com/repos/' + REPO
UPLOAD = 'https://uploads.github.com/repos/' + REPO
VERSION = '0.1.6'
TAG = 'v' + VERSION
SIGNER = '11e792ab77ed0b78538b72e7a12f91745ec38a03a7efddd8854d9734f119ff55'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api(route, method='GET', data=None, binary=False):
    url = route if route.startswith(UPLOAD + '/') else BASE + route
    headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'riye-release-check',
               'X-GitHub-Api-Version': '2022-11-28'}
    if os.environ.get('GH_TOKEN'):
        headers['Authorization'] = 'Bearer ' + os.environ['GH_TOKEN']
    if data is not None:
        data = data if binary else json.dumps(data).encode()
        headers['Content-Type'] = 'application/octet-stream' if binary else 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=180) as response:
            content = response.read()
            return json.loads(content) if content else None
    except urllib.error.HTTPError as error:
        if method == 'GET' and error.code == 404:
            return None
        raise


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify_tag(tag, revision):
    obj = tag['object']
    if obj['type'] == 'tag':
        obj = api('/git/tags/'+obj['sha'])['object']
    assert obj['type'] == 'commit' and obj['sha'] == revision, 'Existing tag belongs to another commit'


def validate_local(config, apk_data):
    assert config['version'] == VERSION
    assert json.loads((ROOT/'package.json').read_text())['version'] == VERSION
    assert config['android']['signer_sha256'] == SIGNER
    assert len(apk_data) == config['android']['size']
    assert digest(apk_data) == config['android']['sha256']
    for name, expected in config['build_inputs'].items():
        assert digest((ROOT/name).read_bytes()) == expected, 'Unreviewed APK input: ' + name
    apk = ROOT/'dist'/('Riye-Android-v'+VERSION+'.apk')
    apk.write_bytes(apk_data)
    with zipfile.ZipFile(apk) as archive:
        assert archive.testzip() is None
        for file in (ROOT/'android/build/assets').iterdir():
            assert archive.read('assets/'+file.name) == file.read_bytes(), 'APK asset mismatch: '+file.name
        assert digest(archive.read('classes.dex')) == config['android']['classes_sha256']
    windows = ROOT/'dist'/('Riye-Windows-x64-v'+VERSION+'.zip')
    with zipfile.ZipFile(windows) as archive:
        prefix = 'Riye-Windows-x64-v'+VERSION+'/resources/app/'
        for directory in ['core', 'desktop', 'renderer']:
            for file in (ROOT/directory).rglob('*'):
                if file.is_file():
                    assert archive.read(prefix+file.relative_to(ROOT).as_posix()) == file.read_bytes()
        assert archive.read(prefix+'package.json') == (ROOT/'package.json').read_bytes()
    source = ROOT/'dist'/('Riye-Source-v'+VERSION+'.zip')
    with zipfile.ZipFile(source) as archive:
        assert archive.testzip() is None
        for name in archive.namelist():
            assert name.startswith('riye-source/')
            relative = name.removeprefix('riye-source/')
            assert not any(part in {'.private', '.tools', 'node_modules', 'data-v1', 'checkpoints', 'revisions', 'backups', 'devices'} for part in Path(relative).parts)
            assert not name.endswith(('.p12', '.pfx', '.jks', '.keystore', '.key', '.pem', '.apk', 'password.txt'))
            assert archive.read(name) == (ROOT/relative).read_bytes(), 'Source archive stale: '+relative
    return windows, apk, source


def verify_assets(release, files=None):
    assets = api('/releases/'+str(release['id'])+'/assets?per_page=100')
    by_name = {asset['name']: asset for asset in assets}
    if files is None:
        expected = {'Riye-Windows-x64-v'+VERSION+'.zip', 'Riye-Android-v'+VERSION+'.apk',
                    'Riye-Source-v'+VERSION+'.zip', 'Riye-Windows-Guide.md', 'Riye-Android-Guide.md', 'SHA256SUMS.txt'}
        assert set(by_name) == expected
        # Public download: no Actions token is sent along redirects.
        with urllib.request.urlopen(by_name['SHA256SUMS.txt']['browser_download_url'], timeout=60) as response:
            sums = response.read()
        assert by_name['SHA256SUMS.txt']['digest'] == 'sha256:'+digest(sums)
        hashes = dict((line.split('  ', 1)[1], line.split('  ', 1)[0]) for line in sums.decode().splitlines())
        assert set(hashes) == expected-{'SHA256SUMS.txt'}
        config = json.loads((ROOT/'releases/0.1.6.json').read_text())
        assert hashes['Riye-Android-v'+VERSION+'.apk'] == config['android']['sha256']
        for name, value in hashes.items():
            assert by_name[name]['state'] == 'uploaded' and by_name[name]['digest'] == 'sha256:'+value
    else:
        assert set(by_name) == {file.name for file in files}
        for file in files:
            asset = by_name[file.name]
            assert asset['state'] == 'uploaded' and asset['size'] == file.stat().st_size
            assert asset['digest'] == 'sha256:'+digest(file.read_bytes()), 'Remote checksum mismatch: '+file.name


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    config = json.loads((ROOT/'releases/0.1.6.json').read_text())
    if args.verify_only:
        data = (ROOT/'dist'/('Riye-Android-v'+VERSION+'.apk')).read_bytes()
    else:
        assert os.environ.get('GITHUB_REPOSITORY') == REPO and os.environ.get('GITHUB_REF') == 'refs/heads/main'
        assert os.environ.get('GH_TOKEN')
        revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        assert revision == os.environ['GITHUB_SHA'] == api('/branches/main')['commit']['sha']
        blob = api('/git/blobs/'+config['android']['blob_sha'])
        assert blob and blob['encoding'] == 'base64' and blob['size'] == config['android']['size']
        data = base64.b64decode(blob['content'])
    windows, apk, source = validate_local(config, data)
    if args.verify_only:
        print('PASS: reviewed source, signed APK, Windows resources and source archive match.')
        return
    tag = api('/git/ref/tags/'+TAG)
    if tag:
        verify_tag(tag, revision)
    release = api('/releases/tags/'+TAG)
    if release and not release['draft']:
        assert tag, 'Published release must have a tag'
        verify_assets(release)
        print('Published release verified:', release['html_url'])
        return
    body = (ROOT/'releases/0.1.6-notes.md').read_text()
    if release is None:
        release = api('/releases', 'POST', {'tag_name': TAG, 'target_commitish': revision,
                      'name': '日页 0.1.6：修复插入空行与手动历史保存', 'body': body, 'draft': True, 'prerelease': True})
    assert release['draft'] and release['target_commitish'] == revision
    guides = []
    for original, name in [('README.md', 'Riye-Windows-Guide.md'), ('ANDROID.md', 'Riye-Android-Guide.md')]:
        target = ROOT/'dist'/name
        target.write_bytes((ROOT/original).read_bytes())
        guides.append(target)
    files = [windows, apk, source, *guides]
    sums = ROOT/'dist/SHA256SUMS.txt'
    sums.write_text(''.join(digest(file.read_bytes())+'  '+file.name+'\n' for file in files))
    files.append(sums)
    existing = {asset['name']: asset for asset in api('/releases/'+str(release['id'])+'/assets?per_page=100')}
    assert set(existing) <= {file.name for file in files}
    for file in files:
        old = existing.get(file.name)
        if old and old['state'] == 'uploaded' and old.get('digest') == 'sha256:'+digest(file.read_bytes()):
            continue
        if old:
            api('/releases/assets/'+str(old['id']), 'DELETE')
        url = UPLOAD+'/releases/'+str(release['id'])+'/assets?name='+urllib.parse.quote(file.name)
        api(url, 'POST', file.read_bytes(), binary=True)
        print('Uploaded:', file.name, flush=True)
    verify_assets(release, files)
    # Re-read after uploads, including a tag created alongside the draft.
    tag = api('/git/ref/tags/'+TAG)
    if tag:
        verify_tag(tag, revision)
    else:
        tag = api('/git/tags', 'POST', {'tag': TAG, 'message': '日页 '+VERSION, 'object': revision, 'type': 'commit',
                  'tagger': {'name': 'github-actions[bot]', 'email': '41898282+github-actions[bot]@users.noreply.github.com',
                             'date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}})
        api('/git/refs', 'POST', {'ref': 'refs/tags/'+TAG, 'sha': tag['sha']})
    release = api('/releases/'+str(release['id']), 'PATCH', {'draft': False, 'prerelease': True, 'body': body})
    assert not release['draft']
    verify_assets(release, files)
    print('Published and verified:', release['html_url'])


if __name__ == '__main__':
    main()
