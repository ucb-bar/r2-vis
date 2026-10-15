"""The checks of trace-raw.md Section 8 (v1.7), plus a few format checks. Vectorized."""

from __future__ import annotations

import numpy as np

from r2t import raw
from r2t.facts import present
from r2t.rawdump import RawDump, nullable
from r2t.timeline import Charges


def run(dump: RawDump, gids: np.ndarray, ch: Charges, stats: dict | None) -> list[str]:
    """Violations as messages. The gid and stats checks need a whole dump: they are
    skipped for a partial dump (filters) and for an incomplete one (no summary.json)."""
    m = dump.manifest
    slots = tuple(m.get("version", (1, 0))) >= (1, 7)
    errors: list[str] = []
    errors += check_unique_gids(gids)
    if not dump.partial and dump.complete:
        errors += check_gid_refs(dump, gids, ch)
    errors += check_ids(dump, ch)
    capacity = [r["capacity"] for r in m["resources"]]
    names = [r["name"] for r in m["resources"]]
    errors += (check_slot_capacity(ch, capacity, names) if slots
               else check_lane_capacity(ch, capacity, names))
    if stats is not None and not dump.partial and dump.complete:
        errors += check_stats(ch, m["resources"], stats, slots)
    errors += check_entries(dump, gids)
    errors += check_write_channels(m, slots)
    if not dump.partial:
        errors += check_program_owners(ch)
    return errors


def check_program_owners(ch: Charges) -> list[str]:
    """Every program owner (raw 1.6: 0x80000000 | spawn, or the root reference) names a
    program of programs.bin."""
    n = int(ch.program_unknown.sum())
    return [f"charges: {n} program owners name no program"] if n else []


def read_channel(m: dict, r: dict) -> int | None:
    """The read channel (or memory port) of a write resource (trace-raw 3.1.2)."""
    role = r["role"]
    kind = role["type"]
    if kind == "link":
        return m["links"][role["link"]][role["dir"]]
    if kind == "port":
        return m["attachments"][role["attachment"]][role["dir"]]
    if kind == "mem_port":
        return m["memories"][role["memory"]]["port"]
    if kind == "bus":
        return next((x["id"] for x in m["resources"]
                     if x["role"] == {"type": "bus", "bus": role["bus"]}), None)
    return None


def check_write_channels(m: dict, slots: bool) -> list[str]:
    """A write channel or write port (raw 1.4, 1.5) has a read channel, the same
    beat_bytes, and capacity = rate / beat_bytes (raw 1.7: rate is per core cycle, so the
    clock ratio is already in it; up to 1.6 lanes = ceil(rate / beat_bytes))."""
    errors = []
    res = m["resources"]
    for r in res:
        if not r["role"].get("write"):
            continue
        rd = read_channel(m, r)
        if rd is None:
            errors.append(f"{r['name']}: write resource without a read channel")
            continue
        if r.get("beat_bytes") != res[rd].get("beat_bytes"):
            errors.append(f"{r['name']}: beat_bytes {r.get('beat_bytes')}, its read channel "
                          f"{res[rd].get('beat_bytes')}")
        if r["rate"] is not None and r.get("beat_bytes"):
            if slots:
                want = r["rate"][0] / (r["rate"][1] * r["beat_bytes"])
                if r["capacity"] is None or abs(r["capacity"] - want) > 1e-9 * max(1.0, want):
                    errors.append(f"{r['name']}: capacity {r['capacity']}, "
                                  f"rate / beat_bytes gives {want}")
            else:
                lanes = -(-r["rate"][0] // (r["rate"][1] * r["beat_bytes"]))
                if r["capacity"] != lanes:
                    errors.append(f"{r['name']}: lanes {r['capacity']}, "
                                  f"rate / beat_bytes gives {lanes}")
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
    for link in m["links"]:
        names += [(f"link {link['path']} {d}", link[d]) for d in ("ab", "ba")]
    for mem in m["memories"]:
        names.append((f"memory {mem['path']} port", mem["port"]))
    for what, rid in names:
        if rid is not None and not 0 <= rid < n:
            errors.append(f"{what}: resource {rid} is not in resources")
    for table in ("nodes", "pes", "buses", "attachments", "links", "memories", "resources"):
        bad = [i for i, entry in enumerate(m[table]) if entry["id"] != i]
        if bad:
            errors.append(f"manifest.{table}: {len(bad)} entries whose id is not their index")
    if len(ch):
        if (ch.dir < 0).any() or (ch.dir > 2).any():
            errors.append("charges: dir outside 0..2")
        bad_msg = ~ch.msg_null & ((ch.msg < 0) | (ch.msg >= len(m["message_kinds"])))
        if bad_msg.any():
            errors.append(f"charges: {int(bad_msg.sum())} msg codes outside message_kinds")
        n_classes = np.array([len(r.get("rates") or []) for r in m["resources"]])
        bad_cls = ~ch.cls_null & ((ch.cls < 0) | (ch.cls >= n_classes[ch.resource]))
        if bad_cls.any():
            errors.append(f"charges: {int(bad_cls.sum())} rate classes outside the "
                          "resource's rates")
        opcodes = dump.records["tasks"]["opcode"]
        if len(opcodes) and opcodes.max() >= len(m["opcodes"]):
            errors.append("tasks: opcode outside opcodes")
    return errors


def check_slot_capacity(ch: Charges, capacity: list[float | None], names: list[str]) -> list[str]:
    """Raw 1.7: on a resource with a rate, at every cycle the usage of the active records,
    summed in 1/65536 slot, is at most floor(capacity x 65536). Zero-span records cover no
    cycle and are left out."""
    cap = np.array([0 if c is None else np.floor(c * raw.USAGE_ONE) for c in capacity],
                   dtype=np.int64)
    sel = (cap[ch.resource] > 0) & (ch.end > ch.start)
    if not sel.any():
        return []
    res, start, end = ch.resource[sel], ch.start[sel], ch.end[sel]
    held = np.rint(ch.usage[sel] * raw.USAGE_ONE).astype(np.int64)
    # Sweep per resource: +held at a start, -held at an end; ends first at one time.
    t = np.concatenate((start, end))
    r = np.concatenate((res, res))
    d = np.concatenate((held, -held))
    order = np.lexsort((d, t, r))
    t, r, d = t[order], r[order], d[order]
    level = np.cumsum(d)
    over = np.flatnonzero(level > cap[r])
    if not len(over):
        return []
    k = over[0]
    return [f"charges: slots held exceed the resource's capacity at {len(over)} events, first on "
            f"{names[r[k]]} at {int(t[k])}: {level[k] / raw.USAGE_ONE:.4f} of "
            f"{cap[r[k]] / raw.USAGE_ONE:.4f}"]


def check_lane_capacity(ch: Charges, lanes: list[float | None], names: list[str]) -> list[str]:
    """On a resource with a rate, the records of one charge (same start and span) hold a
    whole number of lanes, and at every cycle the lanes held by the active records,
    cycles / span summed, are at most the resource's lanes. Zero-cycle records cover no
    cycle and are left out."""
    cap = np.array([0 if n is None else n for n in lanes], dtype=np.int64)
    sel = (cap[ch.resource] > 0) & (ch.end > ch.start)
    res, start, end, cycles = ch.resource[sel], ch.start[sel], ch.end[sel], ch.cycles[sel]
    errors: list[str] = []
    if len(res) == 0:
        return errors
    order = np.lexsort((end, start, res))
    res, start, end = res[order], start[order], end[order]
    cycles = np.rint(cycles[order]).astype(np.int64)
    new = np.concatenate(([True], (res[1:] != res[:-1]) | (start[1:] != start[:-1])
                          | (end[1:] != end[:-1])))
    heads = np.flatnonzero(new)
    sums = np.add.reduceat(cycles, heads)
    span = (end[heads] - start[heads]).astype(np.int64)
    bad_sum = np.flatnonzero(sums % span != 0)
    if len(bad_sum):
        i = heads[bad_sum[0]]
        errors.append(f"charges: {len(bad_sum)} charges whose direction cycles are not a whole "
                      f"number of lanes x span, first on {names[res[i]]} at {int(start[i])}")
    # Sweep per resource: +held at a start, -held at an end; at one time the ends come
    # first (intervals are [start, end)). held is lanes x span / span, a whole number per
    # group of same-interval records, so the sweep runs on integers.
    hr, hs, he = res[heads], start[heads], end[heads]
    held = sums // span
    t = np.concatenate((hs, he))
    r = np.concatenate((hr, hr))
    d = np.concatenate((held, -held))
    order = np.lexsort((d, t, r))
    t, r, d = t[order], r[order], d[order]
    level = np.cumsum(d)
    # Each resource's events sum to 0, so the cumulative sum restarts at 0 per resource.
    over = np.flatnonzero(level > cap[r])
    if len(over):
        k = over[0]
        errors.append(f"charges: lanes held exceed the resource's lanes at {len(over)} events, "
                      f"first on {names[r[k]]} at {int(t[k])}: {int(level[k])} of {int(cap[r[k]])}")
    return errors


def check_stats(ch: Charges, resources: list[dict], stats: dict, slots: bool) -> list[str]:
    """The cycles per resource sum to busy_cycles of the --stats JSON; raw 1.7: the
    slot-cycles to busy_slot_cycles within the rounding of the usages, the sum of
    span / 65536."""
    busy = np.bincount(ch.resource, weights=ch.cycles, minlength=len(resources))
    slack = np.bincount(ch.resource, weights=(ch.end - ch.start) / raw.USAGE_ONE,
                        minlength=len(resources))
    by_name = {r["name"]: r["id"] for r in resources}
    errors = []
    for entry in stats.get("resources", []):
        rid = by_name.get(entry["name"])
        if rid is None:
            errors.append(f"stats: resource {entry['name']} is not in the manifest")
        elif slots:
            want = entry.get("busy_slot_cycles", entry.get("busy_cycles"))
            if abs(busy[rid] - want) > slack[rid] + 1e-6:
                errors.append(f"stats: {entry['name']} busy_slot_cycles {want}, charges sum to "
                              f"{busy[rid]:.3f} (rounding allows {slack[rid]:.3f})")
        elif int(round(busy[rid])) != entry["busy_cycles"]:
            errors.append(f"stats: {entry['name']} busy_cycles {entry['busy_cycles']}, "
                          f"charges sum to {int(round(busy[rid]))}")
    return errors


def check_entries(dump: RawDump, gids: np.ndarray) -> list[str]:
    """entries (trace-raw 4.7 and 8): end >= start; per Neutrino and table the occupancy
    never exceeds the capacity of the manifest; every gid has a task record (whole dumps);
    a pending record with an end has a gid; inbound_invokes ends at the task's invoke; an
    outbound_invokes Invoke starts at the task's queued (the checks against task records:
    whole, complete dumps only)."""
    e = dump.records["entries"]
    if len(e) == 0:
        return []
    m = dump.manifest
    errors: list[str] = []
    start = e["start"].astype(np.int64)
    end, end_null = nullable(e, "end")
    end = end.astype(np.int64)
    table = e["table"].astype(np.int64)
    nu = e["nu"].astype(np.int64)
    gid, gid_null = nullable(e, "gid")
    names = raw.ENTRY_TABLES
    bad_table = table >= len(names)
    if bad_table.any():
        errors.append(f"entries: {int(bad_table.sum())} records with a table code above "
                      f"{len(names) - 1}")
        return errors
    back = ~end_null & (end < start)
    if back.any():
        i = int(np.flatnonzero(back)[0])
        errors.append(f"entries: {int(back.sum())} records end before they start, first "
                      f"{names[table[i]]} at node {nu[i]}: [{start[i]}, {end[i]})")
    # Occupancy: a sweep per (nu, table); at one cycle the frees come before the creations
    # (an entry is [start, end)); an open entry never leaves.
    key = nu * len(names) + table
    t = np.concatenate((start, end[~end_null]))
    k = np.concatenate((key, key[~end_null]))
    d = np.concatenate((np.ones(len(start), np.int64), -np.ones(int((~end_null).sum()), np.int64)))
    order = np.lexsort((d, t, k))
    t, k, d = t[order], k[order], d[order]
    level = np.cumsum(d)
    starts = np.flatnonzero(np.concatenate(([True], k[1:] != k[:-1])))
    base = np.repeat(np.concatenate(([0], level[starts[1:] - 1])),
                     np.diff(np.append(starts, len(k))))
    occ = level - base
    caps = np.full(int(key.max()) + 1, -1, np.int64)
    for n in m.get("nodes", []):
        for j, name in enumerate(names):
            cap = (n.get("neutrino") or {}).get(name)
            if cap is not None and n["id"] * len(names) + j < len(caps):
                caps[n["id"] * len(names) + j] = cap
    over = (caps[k] >= 0) & (occ > caps[k])
    if over.any():
        i = int(np.flatnonzero(over)[0])
        node, tab = divmod(int(k[i]), len(names))
        errors.append(f"entries: occupancy above the capacity at {int(over.sum())} events, first "
                      f"{names[tab]} of node {node} at {int(t[i])}: {int(occ[i])} of "
                      f"{int(caps[k[i]])}")
    pending_open_gid = (table == 0) & ~end_null & gid_null
    if pending_open_gid.any():
        errors.append(f"entries: {int(pending_open_gid.sum())} pending records with an end "
                      "and no gid")
    # The checks against task records need a whole dump (as the gid checks above).
    if dump.partial or not dump.complete:
        return errors
    tasks = dump.records["tasks"]
    order = np.argsort(tasks["gid"], kind="stable")
    tg = tasks["gid"][order].astype(np.int64)
    known = present(tg, gid[~gid_null].astype(np.int64))
    if not known.all():
        errors.append(f"entries: {int((~known).sum())} gids without a task record")
    row = np.searchsorted(tg, gid.astype(np.int64))
    has = ~gid_null & (row < len(tg))
    has[has] &= tg[row[has]] == gid[has]
    invoke = tasks["invoke"][order].astype(np.int64)
    queued = tasks["queued"][order].astype(np.int64)
    ii = (table == 3) & has & ~end_null
    bad = ii & (end != invoke[np.minimum(row, len(tg) - 1)])
    if bad.any():
        i = int(np.flatnonzero(bad)[0])
        errors.append(f"entries: {int(bad.sum())} inbound_invokes records whose end is not the "
                      f"task's invoke, first gid {int(gid[i])}: {int(end[i])} vs "
                      f"{int(invoke[row[i]])}")
    oi = (table == 5) & has & ((e["flags"] & 1) == 0)
    bad = oi & (start != queued[np.minimum(row, len(tg) - 1)])
    if bad.any():
        i = int(np.flatnonzero(bad)[0])
        errors.append(f"entries: {int(bad.sum())} outbound_invokes Invoke records whose start is "
                      f"not the task's queued, first gid {int(gid[i])}: {int(start[i])} vs "
                      f"{int(queued[row[i]])}")
    return errors
