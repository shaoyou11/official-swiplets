import hashlib
import json
import os
from pathlib import Path
import shutil
import zipfile

artifact = Path("skip-chinese-ads/dist/skip-chinese-ads.swiplet")
with zipfile.ZipFile(artifact) as archive:
    manifests = [n for n in archive.namelist() if n.split("/")[-1] == "manifest.json"]
    assert len(manifests) == 1, "Expected one manifest"
    manifest = json.loads(archive.read(manifests[0]))
assert manifest["id"] == "skip-chinese-ads"
release = Path("release")
release.mkdir(exist_ok=True)
shutil.copy2(artifact, release / artifact.name)
tag = "personal-" + os.environ["GITHUB_RUN_NUMBER"]
base = "https://github.com/" + os.environ["GITHUB_REPOSITORY"] + "/releases/download/" + tag + "/"
entry = dict(manifest, url=base + artifact.name, size=artifact.stat().st_size,
             sha256=hashlib.sha256(artifact.read_bytes()).hexdigest())
index = {"name": "SwipleT 自用规则", "swiplets": [entry]}
(release / "source.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n")
