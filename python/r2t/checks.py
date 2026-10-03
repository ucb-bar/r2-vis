"""The checks of trace-raw.md Section 8, plus a few format checks. Vectorized."""

from __future__ import annotations

import numpy as np

from r2t.facts import present
from r2t.rawdump import RawDump, nullable
from r2t.timeline import Charges


def run(dump: RawDump, gids: np.ndarray, ch: Charges, stats: dict | None) -> list[str]:
    """Violations as messages. The gid and stats checks need a whole dump: they are
    skipped for a partial dump (filters) and for an incomplete one (no summary.json)."""
    m = dump.manifest
    errors: list[str] = []
    errors += check_unique_gids(gids)
    if not dump.partial and dump.complete:
        errors += check_gid_refs(dump, gids, ch)
    errors += check_ids(dump, ch)
    errors += check_rated_overlap(ch, [r["rate"] is not None for r in m["resources"]],
                                  [r["name"] for r in m["resources"]])
    if stats is not None and not dump.partial and dump.complete:
        errors += check_stats(ch, m["resources"], stats)
    return errors


def check_unique_gids(gids: np.ndarray) -> list[str]:
    dup = np.flatnonzero(np.diff(gids) == 0)
    if len(dup):
        return [f"tasks: {len(dup)} duplicate gids, first {int(gids[dup[0]])}"]
    return []


def gid_refs(dump: RawDump, ch: Charges) -> list[tuple[str, np.ndarray]]:
    """The non-null gid references of a dump, per field."""
    r = dump.records
    refs = []
    for label, rec, field in (("chunks.gid", r["chunks"], "gid"),
                              ("deps.consumer", r["deps"], "consumer"),
                              ("deps.producer", r["deps"], "producer"),
                              ("programs.spawn", r["programs"], "spawn")):
        values, null = nullable(rec, field)
        refs.append((label, values[~null].astype(np.int64)))
    refs.append(("charges.gid", ch.gid[~ch.gid_null].astype(np.int64)))
    return refs


def check_gid_refs(dump: RawDump, gids: np.ndarray, ch: Charges) -> list[str]:
    """Every gid in chunks, deps, charges and programs.spawn has a task record."""
    errors = []
    for label, values in gid_refs(dump, ch):
        missing = ~present(gids, values)
        if missing.any():
            errors.append(f"{label}: {int(missing.sum())} gids without a task record, "
                          f"first {int(values[missing][0])}")
    return errors


def dangling(dump: RawDump, gids: np.ndarray, ch: Charges) -> dict[str, int]:
    """References to tasks that have no record (allowed in a partial dump)."""
    out = {}
    for label, values in gid_refs(dump, ch):
        n = int((~present(gids, values)).sum())
        if n:
            out[label] = n
    return out


def check_ids(dump: RawDump, ch: Charges) -> list[str]:
    """Resource ids exist; every link that the topology names has a resource; codes are
    in range."""
    m = dump.manifest
    n = len(m["resources"])
    errors = []
    for label, rec, field in (("chunks.culprit", dump.records["chunks"], "culprit"),
                              ("chunks.queue_culprit", dump.records["chunks"], "queue_culprit")):
        values, null = nullable(rec, field)
        if (values[~null] >= n).any():
            errors.append(f"{label}: unknown resource ids")
    names = []
    for a in m["attachments"]:
        names += [(f"attachment {a['id']} {d}", a[d]) for d in ("in", "out")]
    for b in m["bridges"]:
        names += [(f"bridge {b['path']} {d}", b[d]) for d in ("ab", "ba")]
    for mem in m["memories"]:
        names.append((f"memory {mem['path']} port", mem["port"]))
    for what, rid in names:
        if rid is not None and not 0 <= rid < n:
            errors.append(f"{what}: resource {rid} is not in resources")
    for table in ("nodes", "pes", "buses", "attachments", "bridges", "memories", "resources"):
        bad = [i for i, entry in enumerate(m[table]) if entry["id"] != i]
        if bad:
            errors.append(f"manifest.{table}: {len(bad)} entries whose id is not their index")
    if len(ch):
        if (ch.dir < 0).any() or (ch.dir > 2).any():
            errors.append("charges: dir outside 0..2")
        bad_msg = ~ch.msg_null & ((ch.msg < 0) | (ch.msg >= len(m["message_kinds"])))
        if bad_msg.any():
            errors.append(f"charges: {int(bad_msg.sum())} msg codes outside message_kinds")
        opcodes = dump.records["tasks"]["opcode"]
        if len(opcodes) and opcodes.max() >= len(m["opcodes"]):
            errors.append("tasks: opcode outside opcodes")
    return errors


def check_rated_overlap(ch: Charges, rated: list[bool], names: list[str]) -> list[str]:
    """On a rated resource, two charges overlap only if they are the direction records of
    one charge (same start and span); the records of one charge sum to its span.
    Zero-cycle charges cover no cycle and are left out."""
    is_rated = np.array(rated, dtype=bool)
    sel = is_rated[ch.resource] & (ch.end > ch.start)
    res, start, end, cycles = ch.resource[sel], ch.start[sel], ch.end[sel], ch.cycles[sel]
    order = np.lexsort((end, start, res))
    res, start, end, cycles = res[order], start[order], end[order], cycles[order]
    errors = []
    if len(res) == 0:
        return errors
    new = np.concatenate(([True], (res[1:] != res[:-1]) | (start[1:] != start[:-1])
                          | (end[1:] != end[:-1])))
    heads = np.flatnonzero(new)
    sums = np.add.reduceat(cycles.astype(np.int64), heads)
    span = end[heads] - start[heads]
    bad_sum = np.flatnonzero(sums != span)
    if len(bad_sum):
        i = heads[bad_sum[0]]
        errors.append(f"charges: {len(bad_sum)} charges whose direction cycles do not sum to "
                      f"the span, first on {names[res[i]]} at {int(start[i])}")
    hr, hs, he = res[heads], start[heads], end[heads]
    same = hr[1:] == hr[:-1]
    overlap = np.flatnonzero(same & (hs[1:] < he[:-1]))
    if len(overlap):
        i = overlap[0]
        errors.append(f"charges: {len(overlap)} overlapping charges on rated resources, first "
                      f"on {names[hr[i]]}: [{int(hs[i])}, {int(he[i])}) and "
                      f"[{int(hs[i + 1])}, {int(he[i + 1])})")
    return errors


def check_stats(ch: Charges, resources: list[dict], stats: dict) -> list[str]:
    """The cycles per resource sum to busy_cycles of the --stats JSON."""
    busy = np.bincount(ch.resource, weights=ch.cycles, minlength=len(resources))
    by_name = {r["name"]: r["id"] for r in resources}
    errors = []
    for entry in stats.get("resources", []):
        rid = by_name.get(entry["name"])
        if rid is None:
            errors.append(f"stats: resource {entry['name']} is not in the manifest")
        elif int(round(busy[rid])) != entry["busy_cycles"]:
            errors.append(f"stats: {entry['name']} busy_cycles {entry['busy_cycles']}, "
                          f"charges sum to {int(round(busy[rid]))}")
    return errors
