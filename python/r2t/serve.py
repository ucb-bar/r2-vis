"""Serve processed traces over HTTP on the loopback interface: `r2t-serve PATH... [--port N]`.

The GUI opens a served trace by URL and reads its Parquet files by byte range, so a trace on
a remote machine needs no copy: forward the port over SSH and open the printed link.

* The server binds 127.0.0.1 only. There is no option for another address.
* Every path starts with a random token. Other users of the same machine can reach the
  loopback port, but not the files without the token. The token is kept in a file that
  only the user can read ($XDG_RUNTIME_DIR/r2t-serve/token), so the URLs stay the same
  across restarts until a reboot; --new-token makes a new one. `r2t-serve --url` prints the
  URL without serving.
* Cross-origin reads are allowed only from the origins in ALLOWED_ORIGINS and --allow-origin,
  so that another web page in the same browser cannot read a trace through the forward.

Endpoints, below /TOKEN/:
* `index.json`: {"traces": [{"name", "path", "files": {file: bytes}}]}.
* `TRACE/FILE` and `TRACE/sources/FILE`: one file of a trace, with HEAD and
  `Range: bytes=a-b` (206).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote

HOST = "127.0.0.1"
DEFAULT_PORT = 8765
APP_URL = "https://ucb-bar.github.io/r2-vis/"
ALLOWED_ORIGINS = ("https://ucb-bar.github.io", "http://127.0.0.1:5173", "http://localhost:5173")
CHUNK = 1 << 20
SOURCES = "sources"                        # source maps inside a trace (format 1.10)
LINKS = 8                                  # print one link per trace up to this many
RANGE = re.compile(r"bytes=(\d*)-(\d*)$")


@dataclass(frozen=True)
class Catalog:
    """The traces that the server shows: the given .r2t directories, and the .r2t
    directories directly inside the other given directories (scanned at each request)."""

    roots: tuple[Path, ...]

    def traces(self) -> dict[str, Path]:
        """By name: the directory name, or "NAME (PARENT)" for every trace whose directory name
        another listed trace also has."""
        listed = [trace for root in self.roots for trace in (
            [root] if is_trace(root) else sorted(p for p in root.iterdir() if is_trace(p)))]
        counts: dict[str, int] = {}
        for trace in listed:
            counts[trace.name] = counts.get(trace.name, 0) + 1
        found: dict[str, Path] = {}
        for trace in listed:
            name = trace.name if counts[trace.name] == 1 else f"{trace.name} ({trace.parent.name})"
            while name in found:
                name = f"{name}~"
            found[name] = trace
        return found

    def index(self) -> dict:
        return {"traces": [{"name": name, "path": str(path), "files": files_of(path)}
                           for name, path in self.traces().items()]}

    def file(self, trace: str, name: str) -> Path | None:
        """The file, if it is a regular file directly inside a listed trace."""
        root = self.traces().get(trace)
        if root is None or name not in files_of(root):
            return None
        return root / name


def is_trace(path: Path) -> bool:
    """A processed trace; a raw dump also has manifest.json, but no views.sql."""
    return path.is_dir() and (path / "manifest.json").is_file() and (path / "views.sql").is_file()


def files_of(trace: Path) -> dict[str, int]:
    """The files of a trace and of its sources/ folder (format 1.10), by path in the trace."""
    files = [p for p in sorted(trace.iterdir()) if p.is_file()]
    if (trace / SOURCES).is_dir():
        files += [p for p in sorted((trace / SOURCES).iterdir()) if p.is_file()]
    return {p.relative_to(trace).as_posix(): p.stat().st_size for p in files
            if not p.name.startswith(".")}


def byte_range(header: str | None, size: int) -> tuple[int, int] | None:
    """[lo, hi) of a single `bytes=` range, the whole file without a header; None if the
    range is malformed or unsatisfiable."""
    if header is None:
        return 0, size
    m = RANGE.match(header.strip())
    if m is None or (m.group(1) == "" and m.group(2) == ""):
        return None
    if m.group(1) == "":                       # suffix: the last n bytes
        return max(0, size - int(m.group(2))), size
    lo = int(m.group(1))
    hi = size if m.group(2) == "" else min(size, int(m.group(2)) + 1)
    return (lo, hi) if lo < hi else None


def make_handler(catalog: Catalog, token: str, origins: frozenset[str], verbose: bool):
    class Handler(BaseHTTPRequestHandler):
        server_version = "r2t-serve"
        protocol_version = "HTTP/1.1"          # keep-alive: many range reads per trace
        disable_nagle_algorithm = True         # else a reused connection waits ~40 ms per reply

        def do_OPTIONS(self) -> None:
            self.send_response(HTTPStatus.NO_CONTENT)
            self.cors(preflight=True)
            self.end_headers()

        def do_HEAD(self) -> None:
            self.serve(body=False)

        def do_GET(self) -> None:
            self.serve(body=True)

        def serve(self, body: bool) -> None:
            parts = [unquote(p) for p in self.path.split("?", 1)[0].split("/")[1:]]
            if not parts or not secrets.compare_digest(parts[0], token):
                return self.fail(HTTPStatus.NOT_FOUND)
            rest = parts[1:]
            if rest in ([], [""], ["index.json"]):
                data = json.dumps(catalog.index()).encode()
                return self.send_bytes(data, "application/json", body)
            if len(rest) not in (2, 3):
                return self.fail(HTTPStatus.NOT_FOUND)
            path = catalog.file(rest[0], "/".join(rest[1:]))
            if path is None:
                return self.fail(HTTPStatus.NOT_FOUND)
            self.send_file(path, body)

        def send_bytes(self, data: bytes, kind: str, body: bool) -> None:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.cors()
            self.end_headers()
            if body:
                self.wfile.write(data)

        def send_file(self, path: Path, body: bool) -> None:
            size = path.stat().st_size
            span = byte_range(self.headers.get("Range"), size)
            if span is None:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.cors()
                return self.end_headers()
            lo, hi = span
            partial = self.headers.get("Range") is not None
            self.send_response(HTTPStatus.PARTIAL_CONTENT if partial else HTTPStatus.OK)
            self.send_header("Content-Type", "application/json" if path.suffix == ".json"
                             else "application/octet-stream")
            self.send_header("Content-Length", str(hi - lo))
            self.send_header("Accept-Ranges", "bytes")
            if partial:
                self.send_header("Content-Range", f"bytes {lo}-{hi - 1}/{size}")
            self.send_header("Cache-Control", "no-store")
            self.cors()
            self.end_headers()
            if not body:
                return
            with path.open("rb") as f:
                f.seek(lo)
                left = hi - lo
                while left > 0:
                    chunk = f.read(min(CHUNK, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)

        def cors(self, preflight: bool = False) -> None:
            origin = self.headers.get("Origin")
            if origin not in origins:
                return
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers",
                             "Content-Range, Content-Length, Accept-Ranges")
            if preflight:
                self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Range")
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.send_header("Access-Control-Max-Age", "600")

        def fail(self, status: HTTPStatus) -> None:
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.cors()
            self.end_headers()

        def log_message(self, fmt: str, *args) -> None:
            if verbose:
                super().log_message(fmt, *args)

    return Handler


def token_file() -> Path | None:
    """The file that keeps the token, in the user's private runtime directory; None if the
    system has none (then every start makes a new token)."""
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    return Path(runtime) / "r2t-serve" / "token" if runtime and Path(runtime).is_dir() else None


def load_token(renew: bool) -> str:
    """The kept token, or a new one (kept for the next start)."""
    path = token_file()
    if path is not None and not renew and path.is_file():
        token = path.read_text().strip()
        if re.fullmatch(r"[A-Za-z0-9_-]{16,}", token):
            return token
    token = secrets.token_urlsafe(18)
    if path is not None:
        path.parent.mkdir(mode=0o700, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(token + "\n")
    return token


def app_link(url: str) -> str:
    """The GUI opens the trace (or the list of traces) at `url`. The URL is in the fragment,
    so the token never reaches the server of the GUI."""
    return f"{APP_URL}#trace={quote(url, safe='')}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Serve r2t traces on 127.0.0.1 for the r2-vis GUI")
    ap.add_argument("paths", type=Path, nargs="*",
                    help="a trace directory (RUN.r2t), or a directory of trace directories")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"default {DEFAULT_PORT}")
    ap.add_argument("--allow-origin", action="append", default=[],
                    help="another origin that may read the traces, e.g. http://127.0.0.1:4173")
    ap.add_argument("--verbose", action="store_true", help="log every request")
    ap.add_argument("--new-token", action="store_true",
                    help="make a new token (the old URLs stop working)")
    ap.add_argument("--url", action="store_true",
                    help="print the server URL and the GUI link for --port, and exit")
    args = ap.parse_args(argv)
    if args.url:
        base = f"http://{HOST}:{args.port}/{load_token(args.new_token)}/"
        print(base)
        print(app_link(base))
        return 0
    if not args.paths:
        ap.error("give at least one trace directory")
    missing = [p for p in args.paths if not p.is_dir()]
    if missing:
        print(f"error: not a directory: {', '.join(map(str, missing))}", file=sys.stderr)
        return 2
    catalog = Catalog(tuple(p.resolve() for p in args.paths))
    if not catalog.traces():
        print("error: no processed trace (a directory with manifest.json and views.sql) found",
              file=sys.stderr)
        return 2
    token = load_token(args.new_token)
    origins = frozenset(ALLOWED_ORIGINS + tuple(args.allow_origin))
    handler = make_handler(catalog, token, origins, args.verbose)
    try:
        server = ThreadingHTTPServer((HOST, args.port), handler)
    except OSError as e:
        print(f"error: cannot listen on {HOST}:{args.port}: {e.strerror}", file=sys.stderr)
        return 2
    base = f"http://{HOST}:{server.server_port}/{token}/"
    names = list(catalog.traces())
    print(f"serving {len(names)} trace(s) on {base}", flush=True)
    print(f"  all: {app_link(base)}", flush=True)
    for name in names if len(names) <= LINKS else []:
        print(f"  {name}: {app_link(base + quote(name) + '/')}", flush=True)
    print(f"remote machine: ssh -L {server.server_port}:{HOST}:{server.server_port} HOST, "
          "then open a link above", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
