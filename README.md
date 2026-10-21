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

`pixi run build` writes a static build to `web/dist` (or to the directory
in `R2VIS_DIST`). Serve that directory with any static file server.

## License

BSD 3-Clause. See [LICENSE](LICENSE).
