#!/usr/bin/env python3
"""Independently check a read-only scan snapshot against its physical tree."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("snapshot", type=Path)
args = parser.parse_args()
scan = json.loads(args.snapshot.read_text())
root = Path(scan["root"]).resolve()
knowledge_bases, files, directories = set(), {}, {""}


def ignored(path):
    return path.is_symlink() or path.name.startswith(".") or path.name in {"tmp", "node_modules", "__pycache__"}


def content(directory, kb):
    rel = directory.relative_to(root)
    for part in [rel, *rel.parents]:
        directories.add("" if str(part) == "." else part.as_posix())
    for entry in directory.iterdir():
        if ignored(entry):
            continue
        if entry.is_dir():
            content(entry, kb)
        elif entry.suffix.lower() == ".pdf":
            with entry.open("rb") as handle:
                if handle.read(5) != b"%PDF-":
                    continue
            files[str(entry)] = (str(kb), entry.parent.relative_to(root).as_posix())


def discover(directory):
    entries = list(directory.iterdir())
    marker = directory / "raw"
    if marker.is_dir() and not marker.is_symlink():
        knowledge_bases.add(str(directory))
        content(marker, directory)
    for entry in entries:
        if entry.name != "raw" and not ignored(entry) and entry.is_dir():
            discover(entry)


discover(root)
actual_files = {record["path"]: (record["kbRoot"], "/".join(record["collectionParts"])) for record in scan["files"]}
assert {record["path"] for record in scan["knowledgeBases"]} == knowledge_bases
assert actual_files == files, "File ownership or collection chain differs from independent traversal"
assert {"/".join(parts) for parts in scan["directories"]} == directories
assert not scan["errors"]
print(json.dumps({"knowledgeBases": len(knowledge_bases), "files": len(files), "directories": len(directories), "exact_tree_match": True}))
