"""Charges, overview bins and ceilings (trace-format.md Sections 4.2 and 6). Vectorized."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from r2t import raw

BLOCK_ROWS = 512 * 1024      # average rows per charge block (row group)
MIN_BLOCK = 65536            # cycles
MIN_BIN, MAX_BINS = 1024, 32768

CHARGE_SCHEMA = pa.schema([
    ("resource", pa.int32()), ("start", pa.int64()), ("end", pa.int64()),
    ("cycles", pa.int32()), ("amount", pa.int64()), ("dir", pa.int8()),
    ("gid", pa.int32()), ("msg", pa.int8()),
])


def parquet_options(schema: pa.Schema) -> dict:
    """Writer options of every table (trace-format Section 2, pinned physical layout), set
    explicitly: zstd level 3, data pages v1, dictionary encoding for strings only,
    DELTA_BINARY_PACKED for integers, BYTE_STREAM_SPLIT for floats, PLAIN for booleans."""
    encoding, dictionary = {}, []
    for f in schema:
        kind = f.type
        if pa.types.is_dictionary(kind) or pa.types.is_string(kind):
            dictionary.append(f.name)
        elif pa.types.is_integer(kind):
            encoding[f.name] = "DELTA_BINARY_PACKED"
        elif pa.types.is_floating(kind):
            encoding[f.name] = "BYTE_STREAM_SPLIT"
        elif pa.types.is_boolean(kind):
            encoding[f.name] = "PLAIN"
        else:
            raise ValueError(f"no pinned encoding for column {f.name} of type {kind}")
    return {"compression": "zstd", "compression_level": 3, "data_page_version": "1.0",
            "use_dictionary": dictionary, "column_encoding": encoding}


@dataclass
class Charges:
    """The charge columns as numpy arrays; `gid_null` and `msg_null` are null masks."""

    resource: np.ndarray
    start: np.ndarray
    end: np.ndarray
    cycles: np.ndarray
    amount: np.ndarray
    dir: np.ndarray
    gid: np.ndarray
    gid_null: np.ndarray
    msg: np.ndarray
    msg_null: np.ndarray

    @classmethod
    def from_raw(cls, rec: np.ndarray) -> "Charges":
        start = rec["start"].astype(np.int64)
        gid = rec["gid"]
        msg = rec["msg"]
        return cls(
            resource=rec["resource"].astype(np.int32),
            start=start,
            end=start + rec["span"].astype(np.int64),
            cycles=rec["cycles"].astype(np.int32),
            amount=rec["amount"].astype(np.int64),
            dir=rec["dir"].astype(np.int8),
            gid=gid.astype(np.int32),
            gid_null=gid == raw.null_of(gid.dtype),
            msg=msg.astype(np.int8),
            msg_null=msg == raw.null_of(msg.dtype),
        )

    def __len__(self) -> int:
        return len(self.start)

    def take(self, order: np.ndarray) -> "Charges":
        return Charges(**{k: getattr(self, k)[order] for k in self.__dataclass_fields__})


def block_size(end_time: int, rows: int) -> int:
    """Power-of-two block span with about BLOCK_ROWS rows on average, at least MIN_BLOCK."""
    if rows == 0 or end_time <= 0:
        return MIN_BLOCK
    target = end_time * BLOCK_ROWS / rows
    return max(MIN_BLOCK, 1 << max(0, round(np.log2(target))))


def extent(ch: Charges, end_time: int, window: tuple[int, int] | None) -> tuple[int, int]:
    """The time the charges cover: from the first start to the last end, within the window
    of a windowed dump; [0, end_time) without charges."""
    if not len(ch):
        return 0, max(1, end_time)
    lo, hi = int(ch.start.min()), int(ch.end.max())
    if window is not None:
        lo, hi = max(lo, window[0]), min(hi, window[1])
    return lo, max(hi, lo + 1)


def sort_charges(ch: Charges, span_cycles: int) -> tuple[Charges, np.ndarray, int]:
    """Charges in file order (block, resource, start); returns them, their block index and
    the block span (sized to the cycles the charges cover, not the run: a windowed dump
    has all its charges in the window)."""
    span = block_size(span_cycles, len(ch))
    block = ch.start // span
    order = np.lexsort((ch.start, ch.resource, block))
    return ch.take(order), block[order], span


def write_charges(path: Path, ch: Charges, block: np.ndarray, span: int) -> list[dict]:
    """Writes charges.parquet (charges sorted by sort_charges), one row group per non-empty
    time block. Returns manifest.charge_blocks."""
    tab = pa.table({
        "resource": ch.resource, "start": ch.start, "end": ch.end, "cycles": ch.cycles,
        "amount": ch.amount, "dir": ch.dir,
        "gid": pa.array(ch.gid, mask=ch.gid_null),
        "msg": pa.array(ch.msg, mask=ch.msg_null),
    }, schema=CHARGE_SCHEMA)
    blocks: list[dict] = []
    if len(ch):
        cuts = np.flatnonzero(np.diff(block)) + 1
        starts = np.concatenate(([0], cuts))
        stops = np.concatenate((cuts, [len(ch)]))
        max_end = np.maximum.reduceat(ch.end, starts)
    else:
        starts = stops = max_end = np.zeros(0, dtype=np.int64)
    with pq.ParquetWriter(path, CHARGE_SCHEMA, **parquet_options(CHARGE_SCHEMA)) as writer:
        for group, (a, b) in enumerate(zip(starts, stops, strict=True)):
            writer.write_table(tab.slice(a, b - a), row_group_size=int(b - a))
            t0 = int(block[a]) * span
            blocks.append({"group": group, "t0": t0, "t1": t0 + span,
                           "max_end": int(max_end[group]), "rows": int(b - a)})
    return blocks


def bin_grid(lo: int, hi: int) -> tuple[int, int, int]:
    """The bins over [lo, hi) (the charge extent): the smallest power-of-two width of at
    least MIN_BIN cycles with at most MAX_BINS bins from the origin, the origin (lo rounded
    down to the width) and the bin count."""
    width = MIN_BIN
    while -(-(hi - lo // width * width) // width) > MAX_BINS:
        width *= 2
    origin = lo // width * width
    return width, origin, max(1, -(-(hi - origin) // width))


SLICE_ROWS = 1 << 21   # charges per slice of the bin computation (bounds the memory)


def bins(ch: Charges, width: int, origin: int, count: int,
         window: tuple[int, int] | None) -> pa.Table:
    """Spreads each charge's cycles and amount evenly over the bins it covers.

    A zero-cycle charge adds its amount to the bin of its start. In a partial dump the
    charges are clipped to the window first. busy is rounded to whole cycles (INT32) and
    amount stored as FLOAT (trace-format 4.2). Returns the table of non-empty bins
    (sorted by resource, dir, bin); bin b covers [origin + b * width, ...).
    """
    win = None if window is None else (window[0] - origin, window[1] - origin)
    pair = ch.resource.astype(np.int64) * 3 + ch.dir
    keys = np.unique(pair)
    acc = BinAccumulator(len(keys), count, width)
    for a in range(0, len(ch), SLICE_ROWS):
        b = min(a + SLICE_ROWS, len(ch))
        acc.add(np.searchsorted(keys, pair[a:b]), ch.start[a:b] - origin, ch.end[a:b] - origin,
                ch.cycles[a:b], ch.amount[a:b], win)
    k, b, busy, amount = acc.result()
    tab = pa.table({
        "resource": (keys[k] // 3).astype(np.int32),
        "dir": (keys[k] % 3).astype(np.int8),
        "bin": b.astype(np.int32),
        "busy": np.rint(busy).astype(np.int32),
        "amount": amount.astype(np.float32),
    })
    return tab


class BinAccumulator:
    """Dense (key, bin) sums. Full bins inside a charge go through difference arrays,
    and `hits` counts the charges that touch a bin, so that empty bins are exact."""

    def __init__(self, nkeys: int, count: int, width: int) -> None:
        self.nkeys, self.count, self.width = nkeys, count, width
        self.stride = count + 1
        size = nkeys * self.stride
        self.busy = np.zeros(size)
        self.amount = np.zeros(size)
        self.hits = np.zeros(size, dtype=np.int32)
        self.d_busy = np.zeros(size)
        self.d_amount = np.zeros(size)
        self.d_hits = np.zeros(size, dtype=np.int32)

    def add(self, key: np.ndarray, s: np.ndarray, e: np.ndarray, cycles: np.ndarray,
            amount: np.ndarray, window: tuple[int, int] | None) -> None:
        width, count, stride, size = self.width, self.count, self.stride, len(self.busy)
        span = e - s
        if window is not None:
            lo, hi = window
            keep = ((np.minimum(e, hi) > np.maximum(s, lo))
                    | ((span == 0) & (s >= lo) & (s < hi)))
            key, s, e, span = key[keep], s[keep], e[keep], span[keep]
            cycles, amount = cycles[keep], amount[keep]
            s, e = np.maximum(s, lo), np.minimum(e, hi)
        # Per cycle of the (clipped) interval: the charge's cycles and amount over its span.
        length = np.maximum(e - s, 1)
        cyc_rate = np.where(span > 0, cycles / np.maximum(span, 1), 0.0)
        amt_rate = np.where(span > 0, amount / np.maximum(span, 1), amount)
        b0 = np.minimum(s // width, count - 1)
        b1 = np.where(e > s, np.minimum((e - 1) // width, count - 1), b0)
        flat0 = key * stride + b0
        flat1 = key * stride + b1
        single = b0 == b1
        multi = ~single
        first_len = np.where(multi, (b0 + 1) * width - s, length)
        last_len = e - b1 * width
        for flat, part, sel in ((flat0, first_len, slice(None)), (flat1, last_len, multi)):
            f, p = flat[sel], part[sel]
            self.busy += np.bincount(f, cyc_rate[sel] * p, minlength=size)
            self.amount += np.bincount(f, amt_rate[sel] * p, minlength=size)
            self.hits += np.bincount(f, minlength=size)
        mid = multi & (b1 > b0 + 1)
        lo_f, hi_f = flat0[mid] + 1, flat1[mid]
        for diff, rate in ((self.d_busy, cyc_rate[mid]), (self.d_amount, amt_rate[mid])):
            diff += np.bincount(lo_f, rate * width, minlength=size)
            diff -= np.bincount(hi_f, rate * width, minlength=size)
        self.d_hits += np.bincount(lo_f, minlength=size) - np.bincount(hi_f, minlength=size)

    def result(self) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """(key index, bin, busy, amount) of the non-empty bins, sorted by key and bin."""
        shape = (self.nkeys, self.stride)
        for total, diff in ((self.busy, self.d_busy), (self.amount, self.d_amount),
                            (self.hits, self.d_hits)):
            total += np.cumsum(diff.reshape(shape), axis=1).ravel()
        hits = self.hits.reshape(shape)[:, : self.count]
        k, b = np.nonzero(hits > 0)
        flat = k * self.stride + b
        return k, b, self.busy[flat], self.amount[flat]


def ceilings(ch: Charges, rates: list[float | None]) -> np.ndarray:
    """The 100 % line per resource: the rate, or the peak instantaneous throughput of an
    unlimited link (a sweep over its charges; NaN if it has none). A zero-cycle charge
    has no throughput and is left out of the sweep."""
    out = np.array([np.nan if r is None else r for r in rates], dtype=np.float64)
    unlimited = np.isnan(out)
    sel = unlimited[ch.resource] & (ch.end > ch.start)
    if not sel.any():
        return out
    res = ch.resource[sel]
    s, e = ch.start[sel], ch.end[sel]
    v = ch.amount[sel] / (e - s)
    times = np.concatenate((s, e))
    vals = np.concatenate((v, -v))
    rr = np.concatenate((res, res))
    is_start = np.concatenate((np.ones(len(s), np.int8), np.zeros(len(e), np.int8)))
    order = np.lexsort((is_start, times, rr))   # ends before starts at the same cycle
    rr, level = rr[order], np.cumsum(vals[order])
    starts = np.flatnonzero(np.concatenate(([True], rr[1:] != rr[:-1])))
    base = np.concatenate(([0.0], level[starts[1:] - 1]))
    level = level - np.repeat(base, np.diff(np.append(starts, len(rr))))
    out[rr[starts]] = np.maximum.reduceat(level, starts)
    return out


def totals(ch: Charges, n: int) -> tuple[np.ndarray, np.ndarray]:
    """Run totals per resource: busy cycles and amount."""
    busy = np.bincount(ch.resource, weights=ch.cycles, minlength=n)
    amount = np.bincount(ch.resource, weights=ch.amount, minlength=n)
    return np.rint(busy).astype(np.int64), np.rint(amount).astype(np.int64)
