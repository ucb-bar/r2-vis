"""The raw dump format of trace-raw.md v1.0: record layouts, null values, file access."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import zstandard

RAW_VERSION = (1, 0)

# Record layouts of trace-raw.md Section 4, as [name, type] in file order.
LAYOUTS: dict[str, list[list[str]]] = {
    "tasks": [
        ["gid", "u32"], ["nu", "u16"], ["src_nu", "u16"], ["pe", "u16"],
        ["opcode", "u16"], ["version", "u32"], ["label", "u64"],
        ["dst_base", "u64"], ["dst_len", "u64"], ["call", "u64"],
        ["invoke", "u64"], ["ready", "u64"], ["issue", "u64"],
        ["complete", "u64"], ["retire", "u64"], ["queued", "u64"],
        ["sent", "u64"],
    ],
    "chunks": [
        ["gid", "u32"], ["index", "u32"], ["start", "u64"], ["end", "u64"],
        ["culprit", "u16"], ["queue_culprit", "u16"], ["pad", "u32"],
    ],
    "deps": [
        ["consumer", "u32"], ["producer", "u32"], ["resolved", "u64"],
        ["index", "u16"], ["state", "u8"], ["flags", "u8"], ["pad", "u32"],
    ],
    "charges": [
        ["start", "u64"], ["amount", "u64"], ["span", "u32"], ["cycles", "u32"],
        ["gid", "u32"], ["resource", "u16"], ["dir", "u8"], ["msg", "u8"],
    ],
    "programs": [
        ["nu", "u16"], ["pad", "u16"], ["name", "u32"], ["spawn", "u32"],
        ["pad2", "u32"], ["start", "u64"], ["end", "u64"],
    ],
    "marks": [["time", "u64"], ["name", "u32"], ["nu", "u16"], ["pad", "u16"]],
}

RECORD_FILES = tuple(LAYOUTS)

_NUMPY_TYPES = {"u8": "<u1", "u16": "<u2", "u32": "<u4", "u64": "<u8"}

# The message kinds of r2-sim's first real dump (the manifest gives them; the converter
# reads them from there).
MESSAGE_KINDS = [
    "Await", "AwaitAck", "Resolve", "Start", "Return", "Invoke", "VersionReset", "InvokeAck",
    "RetryAck", "Reject", "PCrdGrant",
]

DIR_READ, DIR_WRITE, DIR_WORK = 0, 1, 2


def record_dtype(layout: list[list[str]]) -> np.dtype:
    """The packed little-endian numpy dtype of a record layout."""
    return np.dtype([(name, _NUMPY_TYPES[kind]) for name, kind in layout])


def null_of(dtype: np.dtype) -> int:
    """The null value of an unsigned field type: all bits one."""
    return int(np.iinfo(dtype).max)


def file_path(raw_dir: Path, name: str) -> Path | None:
    """The path of record file `name` (plain or .zst), or None if absent."""
    for candidate in (raw_dir / f"{name}.bin", raw_dir / f"{name}.bin.zst"):
        if candidate.exists():
            return candidate
    return None


def read_bytes(path: Path) -> bytes:
    """The content of a record file; a .zst file is one zstd stream."""
    data = path.read_bytes()
    if path.suffix != ".zst":
        return data
    reader = zstandard.ZstdDecompressor().stream_reader(data, read_across_frames=True)
    with reader:
        return reader.read()


def write_records(raw_dir: Path, name: str, records: np.ndarray, compress: bool) -> Path:
    """Writes a record array as `name.bin` (or `name.bin.zst`)."""
    data = records.tobytes()
    if compress:
        path = raw_dir / f"{name}.bin.zst"
        path.write_bytes(zstandard.ZstdCompressor(level=3).compress(data))
    else:
        path = raw_dir / f"{name}.bin"
        path.write_bytes(data)
    return path


def load_json(path: Path) -> dict | None:
    """A JSON file, or None if absent."""
    if not path.exists():
        return None
    return json.loads(path.read_text())
