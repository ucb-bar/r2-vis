"""SQL access to a processed trace: `r2t-sql OUT.r2t [QUERY]` and `open_trace(path)`.

views.sql uses paths relative to the trace directory (trace-format.md Section 7).
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

import duckdb


def open_trace(path: str | Path) -> duckdb.DuckDBPyConnection:
    """An in-memory DuckDB connection with the views and macros of the trace."""
    root = Path(path).resolve()
    sql = (root / "views.sql").read_text()
    con = duckdb.connect()
    con.execute(f"SET file_search_path = '{root.as_posix()}'")
    con.execute(sql)
    return con


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="DuckDB on an r2t trace, with views.sql loaded")
    ap.add_argument("trace", type=Path, help="the trace directory, e.g. RUN.r2t")
    ap.add_argument("query", nargs="?", help="run this SQL and exit; without it, interactive")
    args = ap.parse_args(argv)
    if not (args.trace / "views.sql").exists():
        print(f"error: {args.trace} has no views.sql", file=sys.stderr)
        return 2
    cli = shutil.which("duckdb")
    if cli is None:
        print("error: the duckdb command is not on PATH (pixi: duckdb-cli)", file=sys.stderr)
        return 2
    cmd = [cli, "-init", "views.sql"] + (["-c", args.query] if args.query else [])
    return subprocess.run(cmd, cwd=args.trace).returncode


if __name__ == "__main__":
    sys.exit(main())
