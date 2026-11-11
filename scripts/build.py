#!/usr/bin/env python3
"""Build an allowlisted XPI from the current development source."""
import hashlib
import json
import re
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "manifest.json").read_text())
files = [root / name for name in ("manifest.json", "prefs.js", "bootstrap.js", "LICENSE")]
files += sorted(p for folder in ("src", "ui") for p in (root / folder).rglob("*") if p.is_file() and p.suffix in {".js", ".xhtml", ".svg"} and not any(part.startswith(".") for part in p.relative_to(root).parts))
for file in files:
    text = file.read_text(encoding="utf-8")
    if "/Users/" in text or "localhost.invalid" in text or re.search(r"@[\w.-]+\.local\b", text):
        raise SystemExit(f"Personal deployment setting found in {file.name}")
dist = root / "dist"
dist.mkdir(exist_ok=True)
output = dist / f"zotero-folder-sync-{manifest['version']}.xpi"
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for file in files:
        info = zipfile.ZipInfo(file.relative_to(root).as_posix(), date_time=(2026, 11, 11, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, file.read_bytes())
client = dist / f"folder-sync-cli-{manifest['version']}.zip"
with zipfile.ZipFile(client, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for filename in ("cli/folder-sync", "LICENSE"):
        info = zipfile.ZipInfo(filename, date_time=(2026, 11, 11, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o100755 if filename.startswith("cli/") else 0o100644) << 16
        archive.writestr(info, (root / filename).read_bytes())
(dist / "SHA256SUMS.txt").write_text("".join(hashlib.sha256(file.read_bytes()).hexdigest() + "  " + file.name + "\n" for file in (output, client)))
print(output)
print(client)
