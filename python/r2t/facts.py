"""Fact tables other than charges and bins (trace-format.md Section 4.2). Vectorized."""

from __future__ import annotations

import numpy as np
import pyarrow as pa

from r2t.rawdump import nullable

TASK_TIMES = ("call", "invoke", "ready", "issue", "complete", "retire", "queued", "sent")


NUMPY_OF = {pa.int8(): np.int8, pa.int32(): np.int32, pa.int64(): np.int64,
            pa.uint64(): np.uint64}


def masked(values: np.ndarray, mask: np.ndarray, kind: pa.DataType) -> pa.Array:
    """A pyarrow array of `values` cast to `kind`, NULL where `mask`."""
    return pa.array(values.astype(NUMPY_OF[kind]), mask=mask, type=kind)


def present(gids: np.ndarray, refs: np.ndarray) -> np.ndarray:
    """For each ref, whether it is a gid in the sorted array `gids`."""
    if len(gids) == 0:
        return np.zeros(len(refs), dtype=bool)
    pos = np.minimum(np.searchsorted(gids, refs), len(gids) - 1)
    return gids[pos] == refs


def per_task_counts(gids: np.ndarray, refs: np.ndarray) -> np.ndarray:
    """Number of refs per task (gids sorted)."""
    ok = present(gids, refs)
    pos = np.searchsorted(gids, refs[ok])
    return np.bincount(pos, minlength=len(gids)).astype(np.int32)


def label_columns(label: np.ndarray, null: np.ndarray, schema: dict) -> dict[str, pa.Array]:
    """One column per label field; a field with an enum becomes a dictionary string."""
    cols: dict[str, pa.Array] = {}
    for f in schema.get("fields", []):
        mask = (1 << f["bits"]) - 1
        v = (label >> np.uint64(f["shift"])) & np.uint64(mask)
        if "enum" in f:
            names = list(f["enum"]) + ["other"]
            idx = np.minimum(v, len(names) - 1).astype(np.int32)
            cols[f["name"]] = pa.DictionaryArray.from_arrays(
                pa.array(idx, mask=null), pa.array(names))
        else:
            kind = pa.int32() if f["bits"] <= 31 else pa.int64()
            cols[f["name"]] = masked(v, null, kind)
    return cols


def tasks_table(rec: np.ndarray, label_schema: dict, lane_of_node: np.ndarray,
                lane_of_pe: np.ndarray, chunk_gids: np.ndarray,
                dep_consumers: np.ndarray) -> tuple[pa.Table, np.ndarray]:
    """The tasks table sorted by gid; also returns the sorted gids."""
    rec = rec[np.argsort(rec["gid"], kind="stable")]
    gids = rec["gid"].astype(np.int64)
    pe, pe_null = nullable(rec, "pe")
    lane = np.where(pe_null, lane_of_node[rec["nu"]],
                    lane_of_pe[np.where(pe_null, 0, pe)]).astype(np.int32)
    label, label_null = nullable(rec, "label")
    version, version_null = nullable(rec, "version")
    cols: dict[str, pa.Array] = {
        "gid": pa.array(gids.astype(np.int32)),
        "nu": pa.array(rec["nu"].astype(np.int32)),
        "src_nu": pa.array(rec["src_nu"].astype(np.int32)),
        "pe": masked(pe, pe_null, pa.int32()),
        "lane": pa.array(lane),
        "opcode": pa.array(rec["opcode"].astype(np.int32)),
        "label": masked(label, label_null, pa.uint64()),
    }
    cols.update(label_columns(label, label_null, label_schema))
    cols["version"] = masked(version, version_null, pa.int32())
    cols["dst_base"] = pa.array(rec["dst_base"], type=pa.uint64())
    cols["dst_len"] = pa.array(rec["dst_len"], type=pa.uint64())
    for name in TASK_TIMES:
        values, null = nullable(rec, name)
        cols[name] = masked(values, null, pa.int64())
    cols["n_chunks"] = pa.array(per_task_counts(gids, chunk_gids))
    cols["n_deps"] = pa.array(per_task_counts(gids, dep_consumers))
    return pa.table(cols), gids


def chunks_table(rec: np.ndarray) -> pa.Table:
    rec = rec[np.lexsort((rec["index"], rec["gid"]))]
    cul, cul_null = nullable(rec, "culprit")
    q, q_null = nullable(rec, "queue_culprit")
    return pa.table({
        "gid": pa.array(rec["gid"].astype(np.int32)),
        "idx": pa.array(rec["index"].astype(np.int32)),
        "start": pa.array(rec["start"].astype(np.int64)),
        "end": pa.array(rec["end"].astype(np.int64)),
        "culprit": masked(cul, cul_null, pa.int32()),
        "queue_culprit": masked(q, q_null, pa.int32()),
    })


def deps_table(rec: np.ndarray) -> pa.Table:
    rec = rec[np.lexsort((rec["index"], rec["consumer"]))]
    producer, producer_null = nullable(rec, "producer")
    resolved, resolved_null = nullable(rec, "resolved")
    return pa.table({
        "consumer": pa.array(rec["consumer"].astype(np.int32)),
        "idx": pa.array(rec["index"].astype(np.int32)),
        "producer": masked(producer, producer_null, pa.int32()),
        "state": pa.array(rec["state"].astype(np.int8)),
        "remote": pa.array((rec["flags"] & 1).astype(bool)),
        "versioned": pa.array((rec["flags"] & 2).astype(bool)),
        "resolved": masked(resolved, resolved_null, pa.int64()),
    })


def string_column(ids: np.ndarray, strings: list[str]) -> pa.Array:
    """Strings by id; an id outside strings.txt becomes NULL."""
    table = np.array(strings + [""], dtype=object)
    bad = ids >= len(strings)
    return pa.array(table[np.where(bad, len(strings), ids)], mask=bad, type=pa.string())


def programs_table(rec: np.ndarray, strings: list[str]) -> pa.Table:
    rec = rec[np.lexsort((rec["start"], rec["nu"]))]
    spawn, spawn_null = nullable(rec, "spawn")
    end, end_null = nullable(rec, "end")
    return pa.table({
        "nu": pa.array(rec["nu"].astype(np.int32)),
        "name": string_column(rec["name"], strings),
        "spawn": masked(spawn, spawn_null, pa.int32()),
        "start": pa.array(rec["start"].astype(np.int64)),
        "end": masked(end, end_null, pa.int64()),
    })


def marks_table(rec: np.ndarray, strings: list[str]) -> pa.Table:
    rec = rec[np.argsort(rec["time"], kind="stable")]
    nu, nu_null = nullable(rec, "nu")
    return pa.table({
        "time": pa.array(rec["time"].astype(np.int64)),
        "name": string_column(rec["name"], strings),
        "nu": masked(nu, nu_null, pa.int32()),
    })


PHASE_SCHEMA = pa.schema([
    ("stage", pa.string()), ("name", pa.string()), ("layer", pa.int32()),
    ("start", pa.int64()), ("end", pa.int64()), ("estimate", pa.int64()),
    ("roofline", pa.int64()), ("bound_by", pa.string()),
])


def phases_table(summary: dict | None) -> pa.Table:
    phases = sorted((summary or {}).get("phases") or [], key=lambda p: p["start"])
    return pa.table({f.name: pa.array([p.get(f.name) for p in phases], type=f.type)
                     for f in PHASE_SCHEMA}, schema=PHASE_SCHEMA)
