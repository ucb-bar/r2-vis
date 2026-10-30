"""Source maps that go into a processed trace: `OUT/sources/NAME.json.gz` (format 1.11; gzip of
the map's bytes as read; `NAME.json` in format 1.10).

A source map (r2-toolchain docs/source-map.md, version 1 or 2) belongs to a run when one of its
programs has the image of a program that ran: equal `image.sha256` and the manifest's
`images[].sha256` (raw 1.10). The candidates are the maps given with --srcmap and a
`srcmap.json` next to an image file of the run, or one directory up (r2-build writes
out/srcmap.json, the ELFs in out/ and the raw images in out/images/).
"""

from __future__ import annotations

import gzip
import json
from collections import Counter
import sys
from pathlib import Path

import pyarrow as pa

from r2t.placement import ProgramMap

SOURCES_DIR = "sources"
MAP_VERSIONS = (1, 2)


def candidates(images: list[dict], given: list[Path]) -> list[Path]:
    """The given maps, then the srcmap.json next to each image file or one directory up,
    without repeats."""
    found = [p.resolve() for p in given]
    for image in images:
        if image.get("file"):
            folder = Path(image["file"]).parent
            found += [p.resolve() for p in (folder / "srcmap.json", folder.parent / "srcmap.json")
                      if p.is_file()]
    return list(dict.fromkeys(found))


def matching(path: Path, hashes: set[str]) -> tuple[str, ...]:
    """The programs of the map whose image ran; empty if the file is not a map of a version
    this converter reads."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return ()
    if data.get("format") != "r2-srcmap" or data.get("version") not in MAP_VERSIONS:
        return ()
    return tuple(p["program"] for p in data.get("programs", [])
                 if p.get("image", {}).get("sha256") in hashes)


def name_of(path: Path, taken: set[str]) -> str:
    """A file name for the map: its crate directory (the parent of r2-build's out/)."""
    base = path.parent.parent.name if path.parent.name == "out" else path.parent.name
    name, k = base or "srcmap", 1
    while name in taken:
        k += 1
        name = f"{base}-{k}"
    return name


def copy_maps(images: list[dict], given: list[Path], out: Path) -> list[dict]:
    """Writes the maps that belong to the run into OUT/sources (gzip); returns the manifest entries.
    A given map that matches no image of the run is reported and left out."""
    hashes = {x["sha256"] for x in images if x.get("sha256")}
    given_set = {p.resolve() for p in given}
    entries: list[dict] = []
    taken: set[str] = set()
    for path in candidates(images, given):
        programs = matching(path, hashes)
        if not programs:
            if path in given_set:
                print(f"warning: {path}: no program of this map ran in the trace "
                      "(image sha256 differs, or not a source map of version 1 or 2)",
                      file=sys.stderr)
            continue
        name = name_of(path, taken)
        taken.add(name)
        (out / SOURCES_DIR).mkdir(exist_ok=True)
        # mtime 0: the same map gives the same bytes
        (out / SOURCES_DIR / f"{name}.json.gz").write_bytes(gzip.compress(path.read_bytes(), mtime=0))
        entries.append({"file": f"{SOURCES_DIR}/{name}.json.gz", "from": str(path),
                        "programs": list(programs)})
    return entries


def unplaced(entries: list[dict], out: Path, tasks: pa.Table, programs: pa.Table,
             images: list[dict], call_paths: list[list[int]]) -> None:
    """Adds to each manifest entry `unplaced`: per program of the map, the tasks that the
    call path and pc do not place (placement.py): `call_path`, an element of the call path
    names no call of the map; `pc`, no item of the function that the path reaches holds the
    pc; `no_item`, of those, the tasks that the pc alone does not place either."""
    maps = [json.loads(gzip.decompress((out / e["file"]).read_bytes())) for e in entries]
    names = programs.column("name").to_pylist()
    image = programs.column("image").to_pylist()
    owner: dict[int, tuple[int, ProgramMap]] = {}
    for row, (name, img) in enumerate(zip(names, image)):
        sha = images[img]["sha256"] if img is not None and img < len(images) else None
        for k, data in enumerate(maps):
            p = next((p for p in data.get("programs", []) if p.get("program") == name
                      and p.get("image", {}).get("sha256") == sha), None)
            if p is not None:
                owner[row] = (k, ProgramMap(p))
                break
    counts = tasks.group_by(["program", "call_path", "pc"]).aggregate([("pc", "count")]).to_pylist()
    miss = [{"call_path": Counter(), "pc": Counter(), "no_item": Counter()} for _ in entries]
    for c in counts:
        hit = owner.get(c["program"])
        if hit is None or c["pc"] is None:
            continue
        k, pm = hit
        path = call_paths[c["call_path"]] if c["call_path"] is not None else None
        placed = pm.place(path, c["pc"])
        if placed.miss is None:
            continue
        name = names[c["program"]]
        miss[k]["call_path" if placed.miss == "path" else "pc"][name] += c["pc_count"]
        if placed.item is None:
            miss[k]["no_item"][name] += c["pc_count"]
    for k, e in enumerate(entries):
        e["unplaced"] = {name: {why: n[name] for why, n in miss[k].items()}
                         for name in e["programs"] if any(n[name] for n in miss[k].values())}
