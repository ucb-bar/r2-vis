# r2-vis

r2-vis shows the traces of r2-sim runs. It has two parts:

* `r2t`, a Python package. Its converter, `r2t-convert`, reads the raw
  dump that r2-sim writes and writes a processed trace: a directory of
  Parquet tables (`RUN.r2t`).
* A web interface (`web/`). It reads a processed trace in the browser and
  shows a block diagram, a timeline and an instant view of the device.

The specification of the trace formats and the views is
[docs/r2vis.pdf](docs/r2vis.pdf).

## Setup

r2-vis uses [pixi](https://pixi.sh) for its environment (Linux, x86-64).

```bash
pixi install
pixi run npm --prefix web ci
```

## Convert a run

Write a raw dump with r2-sim, then convert it once:

```bash
r2sim run ... --trace-raw RUN.raw --stats RUN.json
pixi run r2t-convert RUN.raw RUN.r2t --stats RUN.json
```

`--stats` is optional. With it, the converter also checks the dump against
the statistics of the run. The converter reports each check that fails and
still writes the trace.

For a run of RV images, the converter puts the source maps of the run into
the trace (`RUN.r2t/sources/`), and the interface opens them with the
trace. It finds a `srcmap.json` next to an image file or one directory up
(as r2-build writes them); `--srcmap FILE` adds another one. A map goes in
only when the image hash of one of its programs equals that of a program
that ran.

Without r2-sim, `r2t-synth` writes synthetic raw dumps for tests:

```bash
pixi run r2t-synth SYNTH.raw --tasks 20000
```

## Query a trace in SQL

```bash
pixi run r2t-sql RUN.r2t "select * from util(0, end_time())"
```

Without a query, `r2t-sql` starts an interactive DuckDB session with the
views of the trace loaded. From Python, `r2t.open_trace("RUN.r2t")` gives
a DuckDB connection. `manifest.json` in the trace describes every table and
column.

## Open a trace in the interface

The interface of the latest `master` is at https://ucb-bar.github.io/r2-vis/.
To run it locally:

```bash
pixi run dev
```

Open http://127.0.0.1:5173. In either case, select the `RUN.r2t`
directory, or drop it on the page. The trace stays on your computer: the interface reads the
files in the browser and needs no server.

## Open a trace on another machine

`r2t-serve` serves traces from the machine where they are, on the
loopback interface only (127.0.0.1):

```bash
pixi run r2t-serve RUN.r2t        # or a directory of .r2t directories
```

It prints an `ssh -L` command and one link per trace. Forward the port
from your computer with that command, then open the link. The link opens
the interface with the trace URL after `#trace=`; the interface reads the
files by byte range, so a large trace needs no copy. The URLs hold a
random token, kept in a file that only you can read
(`$XDG_RUNTIME_DIR/r2t-serve/token`), so they stay the same across
restarts until a reboot; `--new-token` makes a new one, and
`r2t-serve --url` prints the URL. The interface keeps a list of recent
servers. The browser asks once for access to the local network; allow
it.

## Sources

The Source tab shows a Neutrino program from the source map that
`r2-build` writes (`srcmap.json`): the source code, with each invoke as
a card of its descriptor values, regions (`// region:` ... `// endregion`)
as folds, and the tasks of the trace that each invoke made. A trace
carries its source maps (see above), so "Open trace and source" opens
both; "Open source map" in the Source tab adds another map.

`pixi run build` writes a static build to `web/dist` (or to the directory
in `R2VIS_DIST`). Serve that directory with any static file server.

## License

BSD 3-Clause. See [LICENSE](LICENSE).
