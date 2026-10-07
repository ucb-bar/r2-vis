"""Reading a raw dump directory (trace-raw.md Section 2) into numpy record arrays."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from r2t import raw


class FormatError(Exception):
    """The dump does not follow trace-raw.md."""


@dataclass
class RawDump:
    manifest: dict
    summary: dict | None
    strings: list[str]
    records: dict[str, np.ndarray]
    dropped_bytes: dict[str, int] = field(default_factory=dict)
    absent: list[str] = field(default_factory=list)

    @property
    def partial(self) -> bool:
        return bool(self.manifest.get("filters", {}).get("partial"))

    @property
    def complete(self) -> bool:
        return self.summary is not None


def load(raw_dir: Path) -> RawDump:
    """Reads every file of a dump. A partial last record is dropped (rule 7)."""
    manifest = raw.load_json(raw_dir / "manifest.json")
    if manifest is None:
        raise FormatError(f"{raw_dir}: no manifest.json")
    if manifest.get("format") != "r2raw":
        raise FormatError(f"{raw_dir}: format is {manifest.get('format')!r}, not r2raw")
    major = manifest.get("version", [None])[0]
    if major != raw.RAW_VERSION[0]:
        raise FormatError(f"{raw_dir}: raw version {manifest.get('version')} not supported")
    add_lane_defaults(manifest)
    bridges_to_links(manifest)
    strings_path = raw_dir / "strings.txt"
    strings = strings_path.read_text().split("\n") if strings_path.exists() else []
    if strings and strings[-1] == "":
        strings.pop()
    summary = raw.load_json(raw_dir / "summary.json")
    dump = RawDump(manifest, summary, strings, {})
    for name in raw.RECORD_FILES:
        layout = manifest.get("records", {}).get(name)
        if layout is None:
            raise FormatError(f"manifest.records has no layout for {name}")
        check_layout(name, layout)
        dtype = raw.record_dtype(layout)
        path = raw.file_path(raw_dir, name)
        if path is None:
            dump.absent.append(name)
            dump.records[name] = np.zeros(0, dtype=dtype)
            continue
        data = raw.read_bytes(path)
        whole = len(data) // dtype.itemsize * dtype.itemsize
        if whole != len(data):
            dump.dropped_bytes[name] = len(data) - whole
        # A view of the file's bytes, without the copy that slicing would make.
        dump.records[name] = np.frombuffer(data, dtype=dtype, count=whole // dtype.itemsize)
    return dump


def add_lane_defaults(manifest: dict) -> None:
    """A 1.0 dump reads as 1.1 with one lane per resource with a rate (trace-raw header)."""
    for r in manifest.get("resources", []):
        if "lanes" not in r:
            r["lanes"] = None if r.get("rate") is None else 1
        r.setdefault("beat_bytes", None)


def bridges_to_links(manifest: dict) -> None:
    """A 1.0 or 1.1 dump's `bridges` as 1.2 `links` (trace-raw 3.1.1, trace-format 4.1):
    from = side a (the child side), to = side b, ab = up. The bridge resources' roles and
    the end attachments' component type become those of a link."""
    if "links" in manifest or "bridges" not in manifest:
        return
    atts, res, buses = manifest["attachments"], manifest["resources"], manifest["buses"]
    mem_of = {mem["path"]: mem["id"] for mem in manifest.get("memories", [])}
    links = []
    for br in manifest.pop("bridges"):
        a, b = atts[br["a"]], atts[br["b"]]
        rate = res[br["ab"]]["rate"] if br["ab"] is not None else None
        links.append({
            "id": br["id"], "path": br["path"], "node": buses[a["bus"]]["node"],
            "control": buses[a["bus"]]["control"], "from_bus": a["bus"], "to_bus": b["bus"],
            "from_attachment": br["a"], "to_attachment": br["b"], "ab": br["ab"], "ba": br["ba"],
            "bw_bytes": None if rate is None else rate[0] / rate[1],
            "beat_bytes": res[br["ab"]].get("beat_bytes") if br["ab"] is not None else None,
            "latency": br["latency"],
            "cache": mem_of.get(br["path"]) if br["type"] == "cache" else None,
        })
    manifest["links"] = links
    for r in res:
        if r["role"]["type"] == "bridge":
            r["role"] = {"type": "link", "link": r["role"]["bridge"], "dir": r["role"]["dir"]}
    for a in atts:
        if a["component_type"] == "bridge":
            a["component_type"] = "link"


def check_layout(name: str, layout: list[list[str]]) -> None:
    """The manifest layout must start with the Section 4 fields; later fields are allowed."""
    expected = raw.LAYOUTS[name]
    if [list(f) for f in layout[: len(expected)]] != expected:
        raise FormatError(f"layout of {name} does not match trace-raw v1.2: {layout}")


def nullable(records: np.ndarray, name: str) -> tuple[np.ndarray, np.ndarray]:
    """(values, null mask) of a field; null is the maximum value of the type."""
    values = records[name]
    return values, values == raw.null_of(values.dtype)


def save_json(path: Path, obj: dict) -> None:
    path.write_text(json.dumps(obj, indent=1))
