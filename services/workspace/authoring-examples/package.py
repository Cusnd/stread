"""Refresh the example resource metadata and reproducible offline ZIP; no conversion/publication."""
from hashlib import sha256
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parent
manifest_path = root / "manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
files = {"index.md", "manifest.json", "package.py"}
for example in manifest["examples"]:
    files.add(example["input"])
    for resource in example["resources"]:
        data = (root / resource["path"]).read_bytes()
        resource.update(size=len(data), sha256=sha256(data).hexdigest())
        files.add(resource["path"])
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
with ZipFile(root / manifest["bundle"], "w", compression=ZIP_DEFLATED) as archive:
    for name in sorted(files):
        info = ZipInfo(name, date_time=(2026, 10, 22, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, (root / name).read_bytes())
print(f"Packaged {len(files)} files in {root / manifest['bundle']}")
