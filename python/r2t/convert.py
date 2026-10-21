"""r2t-convert: raw dump (trace-raw.md v1.0) -> processed trace (trace-format.md v1.0).

    r2t-convert RAW_DIR OUT.r2t [--stats RUN.json]

Reads the dump once, sorts and joins, derives the link classes, the ceilings and the
overview bins, runs the checks of trace-raw Section 8 and writes a directory of Parquet
files with manifest.json and views.sql. Exit status 1 if a check fails (the trace is
written anyway), 2 if the dump cannot be read.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from r2t import checks, dims, facts, schema, timeline
from r2t.rawdump import FormatError, RawDump, load, nullable
from r2t.views import views_sql

FORMAT_VERSION = (1, 8)
# Row groups of trace-format 4.2; bins (not specified there) in groups of 524288 rows, so
# that a reader can decode them in parallel.
ROW_GROUPS = {"tasks": 131072, "chunks": 524288, "deps": 524288, "bins": 524288,
              "entries": 524288, "usage": 262144}


def end_time_of(dump: RawDump) -> int:
    """summary.end_time, or for a dump without summary the latest time in any record."""
    if dump.summary is not None:
        return int(dump.summary["end_time"])
    r = dump.records
    latest = [0]
    for rec, fields in ((r["tasks"], facts.TASK_TIMES), (r["chunks"], ("end",)),
                        (r["deps"], ("resolved",)), (r["programs"], ("end",)),
                        (r["marks"], ("time",))):
        for f in fields:
            values, null = nullable(rec, f)
            if (~null).any():
                latest.append(int(values[~null].max()))
    ch = r["charges"]
    if len(ch):
        latest.append(int((ch["start"] + ch["span"]).max()))
    return max(latest)


def converter_commit() -> str | None:
    """git HEAD of this repository, with -dirty for uncommitted changes."""
    repo = Path(__file__).resolve().parents[2]
    try:
        head = subprocess.run(["git", "-C", str(repo), "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(repo), "status", "--porcelain"],
                               capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    return head + ("-dirty" if dirty else "")


def write(out: Path, name: str, tab: pa.Table) -> None:
    pq.write_table(tab, out / f"{name}.parquet",
                   row_group_size=ROW_GROUPS.get(name, max(1, tab.num_rows)),
                   **timeline.parquet_options(tab.schema))


def prepare_out(out: Path) -> None:
    """Creates OUT; replaces an existing r2t directory, refuses any other directory."""
    if out.exists():
        old = out / "manifest.json"
        is_r2t = old.exists() and json.loads(old.read_text()).get("format") == "r2t"
        if not is_r2t and any(out.iterdir()):
            raise FormatError(f"{out} exists and is not an r2t directory")
        shutil.rmtree(out)
    out.mkdir(parents=True)


def convert(raw_dir: Path, out: Path, stats: dict | None) -> tuple[dict, list[str]]:
    """Converts one dump. Returns the r2t manifest and the check violations."""
    dump = load(raw_dir)
    m = dump.manifest
    rec = dump.records
    end_time = end_time_of(dump)
    filters = m.get("filters") or {}
    window = tuple(filters["window"]) if filters.get("window") else None
    has_rates = np.array([bool(r.get("rates")) for r in m["resources"]], dtype=bool)
    ch = timeline.Charges.from_raw(rec["charges"], rec["programs"], has_rates)
    if len(ch) and int(ch.resource.max()) >= len(m["resources"]):
        raise FormatError(f"charges: resource ids up to {int(ch.resource.max())}, the "
                          f"manifest lists {len(m['resources'])} resources")
    # One sorted copy of the charges serves every step; the raw records are dropped first.
    rec["charges"] = None
    lo, hi = timeline.extent(ch, end_time, window)
    ch, block, block_span = timeline.sort_charges(ch, hi - lo)

    lanes_tab, lane_of_node, lane_of_pe = dims.lanes(m)
    tables: dict[str, pa.Table] = {}
    bus_class = dims.bus_classes(m)
    tables.update(dims.topology_tables(m, bus_class))
    tables["lanes"] = lanes_tab
    rates = [None if r["rate"] is None else r["rate"][0] / r["rate"][1] for r in m["resources"]]
    busy, amount = timeline.totals(ch, len(rates))
    tables["resources"] = dims.resources_table(m, bus_class, timeline.ceilings(ch, rates),
                                               busy, amount)
    tables["rate_classes"] = dims.rate_classes_table(m)

    tasks_tab, gids = facts.tasks_table(
        rec["tasks"], m.get("label", {}), lane_of_node, lane_of_pe,
        rec["chunks"]["gid"].astype(np.int64), rec["deps"]["consumer"].astype(np.int64))
    tables["tasks"] = tasks_tab
    tables["chunks"] = facts.chunks_table(rec["chunks"])
    tables["deps"] = facts.deps_table(rec["deps"])
    tables["programs"] = facts.programs_table(rec["programs"], dump.strings)
    tables["marks"] = facts.marks_table(rec["marks"], dump.strings)
    tables["phases"] = facts.phases_table(dump.summary)
    tables["entries"] = facts.entries_table(rec["entries"])
    width, origin, bin_count = timeline.bin_grid(lo, hi)
    tables["bins"] = timeline.bins(ch, width, origin, bin_count, window)
    tables["usage"] = timeline.usage_table(ch, block)

    errors = checks.run(dump, gids, ch, stats)
    for name, nbytes in dump.dropped_bytes.items():
        print(f"warning: {name}: dropped a partial last record of {nbytes} bytes",
              file=sys.stderr)

    prepare_out(out)
    for name, tab in tables.items():
        write(out, name, tab)
    blocks = timeline.write_charges(out / "charges.parquet", ch, block, block_span)
    rows = {name: tab.num_rows for name, tab in tables.items()}
    rows["charges"] = len(ch)
    label_fields = m.get("label", {}).get("fields", [])
    manifest = {
        "format": "r2t",
        "version": list(FORMAT_VERSION),
        "run": m.get("run", {}),
        "source": {"raw_version": m.get("version"), "converter_commit": converter_commit(),
                   "complete": dump.complete, "filters": filters,
                   "dangling": checks.dangling(dump, gids, ch),
                   "dropped_bytes": dump.dropped_bytes, "absent_records": dump.absent},
        "end_time": end_time,
        "label": m.get("label", {}),
        "bins": {"width": width, "count": bin_count, "origin": origin},
        "charge_block_span": block_span,
        "charge_blocks": blocks,
        "tables": {name: schema.describe(name, rows[name], label_fields)
                   for name in [*tables, "charges"]},
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    (out / "views.sql").write_text(views_sql(m.get("label", {}), end_time, width, origin))
    return manifest, errors


def report(out: Path, manifest: dict, seconds: float) -> None:
    print(f"{out}: end_time {manifest['end_time']}, bins {manifest['bins']}, "
          f"{len(manifest['charge_blocks'])} charge blocks of {manifest['charge_block_span']} "
          f"cycles, {seconds:.1f} s")
    for name, entry in manifest["tables"].items():
        size = (out / f"{name}.parquet").stat().st_size
        print(f"  {name:14s} {entry['rows']:>10d} rows {size / 1e6:9.2f} MB")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("raw", type=Path, help="raw dump directory (r2sim --trace-raw)")
    ap.add_argument("out", type=Path, help="output directory, e.g. RUN.r2t")
    ap.add_argument("--stats", type=Path,
                    help="the run's --stats JSON: check busy_cycles against the charges")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    stats = json.loads(args.stats.read_text()) if args.stats else None
    t0 = time.perf_counter()
    try:
        manifest, errors = convert(args.raw, args.out, stats)
    except FormatError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    if not args.quiet:
        report(args.out, manifest, time.perf_counter() - t0)
    for e in errors:
        print(f"check failed: {e}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
