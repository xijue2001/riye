"""Download official Electron binaries, checking the release SHA-256 list."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import sys
import urllib.request

VERSION = json.loads((Path(__file__).resolve().parent.parent / "runtime.json").read_text())["electron"]
BASE = f"https://github.com/electron/electron/releases/download/v{VERSION}/"
DEST = Path(sys.argv[1] if len(sys.argv) > 1 else ".runtime")
DEST.mkdir(parents=True, exist_ok=True)
with urllib.request.urlopen(BASE + "SHASUMS256.txt", timeout=30) as response:
    checksums = dict((line.split()[1].lstrip("*"), line.split()[0])
                     for line in response.read().decode().splitlines() if line.strip())

def download(platform):
    name = f"electron-v{VERSION}-{platform}-x64.zip"
    target = DEST / name
    expected = checksums[name]
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
        print(f"Verified cached {name}", flush=True)
        return
    partial = target.with_suffix(".part")
    digest = hashlib.sha256()
    total = 0
    with urllib.request.urlopen(BASE + name, timeout=60) as response, partial.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            digest.update(chunk)
            total += len(chunk)
    if digest.hexdigest() != expected:
        partial.unlink(missing_ok=True)
        raise RuntimeError("SHA-256 mismatch: " + name)
    partial.replace(target)
    print(f"Verified {name}: {total:,} bytes", flush=True)

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    list(pool.map(download, sys.argv[2:] or ["win32", "linux"]))
