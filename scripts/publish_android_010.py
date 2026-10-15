"""Finish one verified historical draft; never build, upload, or replace assets."""

import json
import os
import urllib.error
import urllib.request

REPOSITORY = "xijue2001/riye"
RELEASE_ID = 413339108
TAG = "android-v0.1.0"
TARGET = "ba0ba44bca07b149cba4e7cd12ddc3e6136278c8"
ASSETS = {
    "Riye-Android-v0.1.0.apk": (
        1411570,
        "0a1087e1051faa2314b4c0c91bf6ca12b69d33eddb3aa8f594b833e647555c04",
    ),
    "Riye-Android-Guide.md": (
        4609,
        "3aa2cf5194ffb596105a4fdc3ea4c932c5208c2ec2e758bda40a01b910e0824c",
    ),
    "SHA256SUMS.txt": (
        90,
        "6b9422cece021abb4bfce638ad970f27d8593fa1f5ef7c7497ff88a8ec73dfe4",
    ),
}


def validate(release):
    if (release["id"], release["tag_name"], release["target_commitish"]) != (
        RELEASE_ID, TAG, TARGET
    ):
        raise ValueError("Unexpected release identity or source commit")
    if release["prerelease"] is not True:
        raise ValueError("Android 0.1.0 must remain a pre-release")
    actual = {
        asset["name"]: (asset["size"], asset.get("digest"), asset["state"])
        for asset in release["assets"]
    }
    expected = {
        name: (size, "sha256:" + digest, "uploaded")
        for name, (size, digest) in ASSETS.items()
    }
    if len(release["assets"]) != len(expected) or actual != expected:
        raise ValueError("Release asset names, sizes, states, or hashes differ")


def main():
    if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise ValueError("This historical publisher is restricted to its original repository")
    headers = {
        "Authorization": "Bearer " + os.environ["GH_TOKEN"],
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
    }

    def request(path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            f"https://api.github.com/repos/{REPOSITORY}/{path}",
            data=data, headers=headers, method="GET" if body is None else "PATCH",
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    path = f"releases/{RELEASE_ID}"
    release = request(path)
    validate(release)
    try:
        tag = request(f"git/ref/tags/{TAG}")
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
    else:
        if tag["object"]["type"] != "commit" or tag["object"]["sha"] != TARGET:
            raise ValueError("Existing historical tag points to a different commit")
    if release["draft"]:
        release = request(path, {"draft": False, "prerelease": True, "make_latest": "false"})
        validate(release)
    if release["draft"] or not release["published_at"]:
        raise ValueError("Release was not published")
    tag = request(f"git/ref/tags/{TAG}")
    if tag["object"]["type"] != "commit" or tag["object"]["sha"] != TARGET:
        raise ValueError("Published tag does not match the original Android source")
    print(f"Published {TAG}: {release['html_url']}")


if __name__ == "__main__":
    main()
