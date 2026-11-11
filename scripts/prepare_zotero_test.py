#!/usr/bin/env python3
"""Create a NEW disposable Zotero Profile and synthetic PDF fixture."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path)
parser.add_argument("--port", type=int, default=23127)
args = parser.parse_args()
base = args.directory.expanduser().resolve()
if base.exists():
    parser.error("choose a new directory; an existing environment is never replaced")
if not 1024 <= args.port <= 65535:
    parser.error("choose a local test port between 1024 and 65535")
(base / "profile").mkdir(parents=True)
(base / "data").mkdir()
(base / ".isolated-test-marker").write_text("folder-sync-test-only\n")
preferences = {
    "extensions.zotero.useDataDir": True,
    "extensions.zotero.dataDir": str(base / "data"),
    "extensions.zotero.sync.autoSync": False,
    "extensions.zotero.streaming.enabled": False,
    "extensions.zotero.httpServer.enabled": True,
    "extensions.zotero.httpServer.port": args.port,
    "extensions.folderSync.apiEnabled": True,
}
(base / "profile/user.js").write_text("".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});\n" for k, v in preferences.items()))
objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
           b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
           b"<< /Length 0 >>\nstream\n\nendstream"]
pdf, offsets = b"%PDF-1.4\n", []
for index, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"
xref = len(pdf)
pdf += b"xref\n0 5\n0000000000 65535 f \n"
pdf += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
pdf += f"trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
for relative in ["knowledge/主题/raw/papers/方法 A/a.pdf", "knowledge/主题/raw/standards/s.pdf",
                 "knowledge/主题/raw/archive/raw/b.pdf", "knowledge/主题/child/raw/technical/c.pdf",
                 "ordinary/root.pdf", "ordinary/sub/paper.pdf"]:
    target = base / "fixture" / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(pdf)
(base / "fixture/knowledge/主题/raw/papers/empty").mkdir()
print(json.dumps({"profile": str(base / "profile"), "data": str(base / "data"), "fixture": str(base / "fixture")}, ensure_ascii=False, indent=2))
