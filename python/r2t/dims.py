"""Dimension tables of the processed trace (trace-format.md Sections 4.1 and 5)."""

from __future__ import annotations

from collections import deque

import numpy as np
import pyarrow as pa

UNITS = {"TensorOps": "MAC", "VectorOps": "lane-op", "ScalarOps": "instr", "Bandwidth": "B",
         "Slots": "slot"}
DIRS = ["read", "write", "work"]
DEP_STATES = ["not_invoked", "scoreboard", "executing", "done"]
LINK_ROLES = {"port", "bus", "bridge"}


def table(columns: dict[str, tuple[list, pa.DataType]]) -> pa.Table:
    """A pyarrow table from {name: (values, type)}; None values become NULL."""
    return pa.table({name: pa.array(values, type=kind) for name, (values, kind) in
                     columns.items()})


def code_table(names: list[str]) -> pa.Table:
    return table({"id": (list(range(len(names))), pa.int32()), "name": (names, pa.string())})


NEUTRINO_TABLES = ("scoreboard", "pending", "execution", "versions", "inbound_refs",
                   "inbound_invokes", "outbound_deps", "outbound_invokes")


def nodes_table(nodes: list[dict]) -> pa.Table:
    """Nodes with the table capacities of their Neutrino (NULL if the dump has none)."""
    depth = [n["path"].count(".") for n in nodes]
    caps = {f"cap_{t}": ([(n.get("neutrino") or {}).get(t) for n in nodes], pa.int32())
            for t in NEUTRINO_TABLES}
    return table({
        "id": ([n["id"] for n in nodes], pa.int32()),
        "path": ([n["path"] for n in nodes], pa.string()),
        "name": ([n["path"].rsplit(".", 1)[-1] for n in nodes], pa.string()),
        "parent": ([n["parent"] for n in nodes], pa.int32()),
        "depth": (depth, pa.int32()),
        **caps,
    })


def lanes(m: dict) -> tuple[pa.Table, np.ndarray, np.ndarray]:
    """Lanes in node order (the Neutrino lane first, then the node's PEs).

    Returns the table and the lane id of each node and of each PE.
    """
    rows = []
    lane_of_node = np.zeros(len(m["nodes"]), dtype=np.int32)
    lane_of_pe = np.zeros(len(m["pes"]), dtype=np.int32)
    pes_by_node: dict[int, list[dict]] = {}
    for p in m["pes"]:
        pes_by_node.setdefault(p["node"], []).append(p)
    for n in m["nodes"]:
        lane_of_node[n["id"]] = len(rows)
        rows.append((f"{n['path']}.neutrino", n["id"], None, "neutrino"))
        for p in pes_by_node.get(n["id"], []):
            lane_of_pe[p["id"]] = len(rows)
            rows.append((p["path"], n["id"], p["id"], p["type"]))
    tab = table({
        "id": (list(range(len(rows))), pa.int32()),
        "path": ([r[0] for r in rows], pa.string()),
        "node": ([r[1] for r in rows], pa.int32()),
        "pe": ([r[2] for r in rows], pa.int32()),
        "type": ([r[3] for r in rows], pa.string()),
    })
    return tab, lane_of_node, lane_of_pe


def bus_classes(m: dict) -> list[str]:
    """Class of every bus (Section 5, rules 1 to 3)."""
    buses, atts = m["buses"], m["attachments"]
    data = [not b["control"] for b in buses]
    edges: dict[int, list[int]] = {}
    for br in m["bridges"]:
        if br["type"] != "child":
            continue  # caches stop the global search
        a, b = atts[br["a"]]["bus"], atts[br["b"]]["bus"]
        if data[a] and data[b]:
            edges.setdefault(a, []).append(b)
            edges.setdefault(b, []).append(a)
    starts = {atts[a]["bus"] for mem in m["memories"] if mem["type"] == "dram"
              for a in mem["attachments"]}
    reached = set(s for s in starts if data[s])
    queue = deque(reached)
    while queue:
        bus = queue.popleft()
        for nxt in edges.get(bus, []):
            if nxt not in reached:
                reached.add(nxt)
                queue.append(nxt)
    return ["control" if not data[i] else "global" if i in reached else "local"
            for i in range(len(buses))]


def resource_classes(m: dict, bus_class: list[str]) -> list[str | None]:
    """Class of every resource (Section 5, rules 1, 4 and 5)."""
    atts, bridges, mems = m["attachments"], m["bridges"], m["memories"]
    out: list[str | None] = []
    for r in m["resources"]:
        role = r["role"]
        kind = role["type"]
        if kind == "port":
            cls = bus_class[atts[role["attachment"]]["bus"]]
        elif kind == "bus":
            cls = bus_class[role["bus"]]
        elif kind == "bridge":
            # A child bridge joins two buses of one class (rule 4); a control bridge joins
            # control buses.
            cls = bus_class[atts[bridges[role["bridge"]]["a"]]["bus"]]
        elif kind == "mem_port":
            cls = "global" if mems[role["memory"]]["type"] == "dram" else "local"
        elif kind == "pe":
            cls = "compute"
        elif kind in ("scalar", "complete"):
            cls = "scalar"
        else:
            cls = None
        out.append(cls)
    return out


def resources_table(m: dict, bus_class: list[str], ceiling: np.ndarray,
                    busy_cycles: np.ndarray, amount: np.ndarray) -> pa.Table:
    res, atts = m["resources"], m["attachments"]
    classes = resource_classes(m, bus_class)

    def role_field(r: dict, key: str):
        return r["role"].get(key)

    bus, link_dir = [], []
    for r in res:
        role = r["role"]
        if role["type"] == "port":
            bus.append(atts[role["attachment"]]["bus"])
            link_dir.append(role["dir"])
        elif role["type"] == "bus":
            bus.append(role["bus"])
            link_dir.append(None)
        elif role["type"] == "bridge":
            bus.append(None)
            link_dir.append("up" if role["dir"] == "ab" else "down")
        else:
            bus.append(None)
            link_dir.append(None)
    rate = [None if r["rate"] is None else r["rate"][0] / r["rate"][1] for r in res]
    return table({
        "id": ([r["id"] for r in res], pa.int32()),
        "name": ([r["name"] for r in res], pa.string()),
        "node": ([r["owner"] for r in res], pa.int32()),
        "kind": ([r["kind"] for r in res], pa.string()),
        "unit": ([UNITS.get(r["kind"]) for r in res], pa.string()),
        "rate": (rate, pa.float64()),
        "ceiling": ([None if np.isnan(c) else float(c) for c in ceiling], pa.float64()),
        "role": ([r["role"]["type"] for r in res], pa.string()),
        "bus": (bus, pa.int32()),
        "attachment": ([role_field(r, "attachment") for r in res], pa.int32()),
        "bridge": ([role_field(r, "bridge") for r in res], pa.int32()),
        "memory": ([role_field(r, "memory") for r in res], pa.int32()),
        "pe": ([role_field(r, "pe") for r in res], pa.int32()),
        "link_dir": (link_dir, pa.string()),
        "is_link": ([r["role"]["type"] in LINK_ROLES for r in res], pa.bool_()),
        "class": (classes, pa.string()),
        "busy_cycles": ([int(x) for x in busy_cycles], pa.int64()),
        "amount": ([int(x) for x in amount], pa.int64()),
    })


def topology_tables(m: dict, bus_class: list[str]) -> dict[str, pa.Table]:
    """Every dimension table except resources and lanes."""
    atts = m["attachments"]
    tabs = {
        "nodes": nodes_table(m["nodes"]),
        "pes": table({
            "id": ([p["id"] for p in m["pes"]], pa.int32()),
            "path": ([p["path"] for p in m["pes"]], pa.string()),
            "node": ([p["node"] for p in m["pes"]], pa.int32()),
            "type": ([p["type"] for p in m["pes"]], pa.string()),
        }),
        "buses": table({
            "id": ([b["id"] for b in m["buses"]], pa.int32()),
            "path": ([b["path"] for b in m["buses"]], pa.string()),
            "node": ([b["node"] for b in m["buses"]], pa.int32()),
            "topology": ([b["topology"] for b in m["buses"]], pa.string()),
            "control": ([b["control"] for b in m["buses"]], pa.bool_()),
            "bw_bytes": ([b["bw_bytes"] for b in m["buses"]], pa.int64()),
            "latency": ([b["latency"] for b in m["buses"]], pa.int64()),
            "class": (bus_class, pa.string()),
        }),
        "attachments": table({
            "id": ([a["id"] for a in atts], pa.int32()),
            "bus": ([a["bus"] for a in atts], pa.int32()),
            "name": ([a["name"] for a in atts], pa.string()),
            "component": ([a["component"] for a in atts], pa.string()),
            "component_type": ([a["component_type"] for a in atts], pa.string()),
            "role": ([a["role"] for a in atts], pa.string()),
            "in_resource": ([a["in"] for a in atts], pa.int32()),
            "out_resource": ([a["out"] for a in atts], pa.int32()),
        }),
        "bridges": table({
            "id": ([b["id"] for b in m["bridges"]], pa.int32()),
            "path": ([b["path"] for b in m["bridges"]], pa.string()),
            "type": ([b["type"] for b in m["bridges"]], pa.string()),
            "a_attachment": ([b["a"] for b in m["bridges"]], pa.int32()),
            "b_attachment": ([b["b"] for b in m["bridges"]], pa.int32()),
            "a_bus": ([atts[b["a"]]["bus"] for b in m["bridges"]], pa.int32()),
            "b_bus": ([atts[b["b"]]["bus"] for b in m["bridges"]], pa.int32()),
            "ab_resource": ([b["ab"] for b in m["bridges"]], pa.int32()),
            "ba_resource": ([b["ba"] for b in m["bridges"]], pa.int32()),
            "latency": ([b["latency"] for b in m["bridges"]], pa.int64()),
        }),
        "memories": table({
            "id": ([x["id"] for x in m["memories"]], pa.int32()),
            "path": ([x["path"] for x in m["memories"]], pa.string()),
            "node": ([x["node"] for x in m["memories"]], pa.int32()),
            "type": ([x["type"] for x in m["memories"]], pa.string()),
            "port": ([x["port"] for x in m["memories"]], pa.int32()),
            "bw_bytes": ([x["bw_bytes"] for x in m["memories"]], pa.int64()),
            "latency": ([x["latency"] for x in m["memories"]], pa.int64()),
        }),
    }
    ranges = [(x["id"], int(lo, 16), int(hi, 16)) for x in m["memories"]
              for lo, hi in x["ranges"]]
    tabs["memory_ranges"] = table({
        "memory": ([r[0] for r in ranges], pa.int32()),
        "lo": ([r[1] for r in ranges], pa.uint64()),
        "hi": ([r[2] for r in ranges], pa.uint64()),
    })
    tabs["opcodes"] = code_table(m["opcodes"])
    tabs["message_kinds"] = code_table(m["message_kinds"])
    tabs["dirs"] = code_table(DIRS)
    tabs["dep_states"] = code_table(DEP_STATES)
    return tabs
