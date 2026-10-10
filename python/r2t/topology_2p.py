"""The topology of r2-sim configs/2p.yaml as manifest tables (trace-raw.md Section 3.1).

The tables follow r2-sim's raw 1.2 dump (scratch/lanesB/l1) entry for entry:

* nodes, buses and PEs depth-first over the node tree;
* attachments per node in creation order (Neutrino, data link, control link,
  compute masters), then the memory attachments of the whole tree;
* rated resources per node in creation order (link directions, Neutrino, bus ports,
  memory port,
  PEs), then the rated ports of the memory attachments;
* then the ports with `rate: null`, in attachment order: every attachment of an
  unlimited bus, and the compute masters on a rated xbar;
* memories: the memories with a port depth-first, then the sync memories.
"""

from __future__ import annotations

import math

from dataclasses import dataclass, field

GPCS = 2
SMS_PER_GPC = 4
GPC_LINK_BW, GPC_LINK_LATENCY = 256, 20
SM_LINK_BW, SM_LINK_LATENCY = 128, 10
SYNC_RANGE = (0x1F0000000, 0x1F1000000)
HBM_RANGE = (0x0, 0xF0000000)
SMEM_RANGE = (0x0, 0x100000)
BEAT_BYTES = 64             # r2-sim default beat of ports, links and memory ports
# Neutrino table capacities (2p.yaml, gpc.yaml, sm.yaml): gpcs have 1024 versions.
NEUTRINO = {"scoreboard": 128, "pending": 256, "execution": 256, "versions": 256,
            "inbound_refs": 128, "inbound_invokes": 64, "outbound_deps": 128,
            "outbound_invokes": 32}
NEUTRINO_GPC = {**NEUTRINO, "versions": 1024}


def link_name(from_bus: str, to_bus: str) -> str:
    """The r2-sim link name `<from bus>_to_<to bus>` (last path components)."""
    return f"{from_bus.rsplit('.', 1)[1]}_to_{to_bus.rsplit('.', 1)[1]}"


def own_base(gpc: int | None, sm: int | None, sm_bits: int = 3) -> int:
    """Base of a node's own address space (2p.yaml: offset_bits 33, fields gpc:2, sm:3; a
    larger variant widens the sm field)."""
    base = 0
    if gpc is not None:
        base |= (gpc + 1) << (33 + sm_bits)
    if sm is not None:
        base |= (sm + 1) << 33
    return base


@dataclass
class Topology:
    """Manifest topology tables and the lookups the generator needs."""

    nodes: list[dict] = field(default_factory=list)
    pes: list[dict] = field(default_factory=list)
    buses: list[dict] = field(default_factory=list)
    attachments: list[dict] = field(default_factory=list)
    links: list[dict] = field(default_factory=list)
    gpcs: int = GPCS
    sms: int = SMS_PER_GPC
    sm_bits: int = 3
    memories: list[dict] = field(default_factory=list)
    resources: list[dict] = field(default_factory=list)
    res_id: dict[str, int] = field(default_factory=dict)
    node_id: dict[str, int] = field(default_factory=dict)
    pe_id: dict[str, int] = field(default_factory=dict)
    bus_id: dict[str, int] = field(default_factory=dict)

    def rate(self, rid: int) -> float | None:
        """Units per cycle of a resource, or None if unlimited."""
        r = self.resources[rid]["rate"]
        return None if r is None else r[0] / r[1]

    def bus_rate(self, bus: str) -> float | None:
        return self.buses[self.bus_id[bus]]["bw_bytes"]

    def add_node(self, path: str, parent: str | None, neutrino: dict[str, int]) -> None:
        self.node_id[path] = len(self.nodes)
        self.nodes.append({"id": len(self.nodes), "path": path,
                           "parent": None if parent is None else self.node_id[parent],
                           "neutrino": dict(neutrino)})

    def add_resource(self, name: str, kind: str, rate: float | None, owner: str,
                     role: dict) -> int:
        rid = len(self.resources)
        # Lanes (trace-raw v1.1): a bandwidth resource has one lane per beat of BEAT_BYTES;
        # compute arrays and scalar units have one lane; an unlimited resource has none.
        if rate is None:
            lanes, beat = None, None
        elif kind == "Bandwidth":
            lanes, beat = math.ceil(rate / BEAT_BYTES), BEAT_BYTES
        else:
            lanes, beat = 1, None
        self.resources.append({"id": rid, "name": name, "kind": kind,
                               "rate": None if rate is None else [int(rate), 1],
                               "lanes": lanes, "beat_bytes": beat,
                               "owner": self.node_id[owner], "role": role})
        self.res_id[name] = rid
        return rid

    def add_bus(self, path: str, node: str, control: bool, bw: float | None) -> None:
        self.bus_id[path] = len(self.buses)
        self.buses.append({"id": len(self.buses), "path": path, "node": self.node_id[node],
                           "topology": "xbar", "control": control, "bw_bytes": bw,
                           "latency": 0})

    def add_attachment(self, bus: str, name: str, component: str, component_type: str,
                       role: str) -> int:
        aid = len(self.attachments)
        self.attachments.append({"id": aid, "bus": self.bus_id[bus], "name": name,
                                 "component": component, "component_type": component_type,
                                 "role": role, "in": None, "out": None})
        return aid

    def add_ports(self, aid: int, rated: bool) -> None:
        """The ingress and egress port resources of an attachment; at the bus's rate, or
        with rate null (an unlimited bus, or a compute master)."""
        att = self.attachments[aid]
        bus = self.buses[att["bus"]]
        owner = self.nodes[bus["node"]]["path"]
        for direction in ("in", "out"):
            att[direction] = self.add_resource(
                f"{bus['path']}.{att['name']}.{direction}", "Bandwidth",
                bus["bw_bytes"] if rated else None, owner,
                {"type": "port", "attachment": aid, "dir": direction})


@dataclass
class _Memory:
    path: str
    node: str
    mtype: str
    ranges: list[list[str]]
    slaves: list[str]
    port: int | None
    bw: float | None
    latency: int


class _Builder:
    """Builds the 2p tables in r2-sim's creation order."""

    def __init__(self) -> None:
        self.t = Topology()
        self.memories: list[_Memory] = []

    def attach(self, bus: str, name: str, component: str, ctype: str, role: str) -> None:
        """An attachment; a Neutrino or link end on a rated bus gets its rated ports now."""
        aid = self.t.add_attachment(bus, name, component, ctype, role)
        if ctype in ("neutrino", "link") and self.t.bus_rate(bus) is not None:
            self.t.add_ports(aid, rated=True)

    def neutrino(self, path: str, buses: list[str]) -> None:
        t = self.t
        nid = t.node_id[path]
        t.add_resource(f"{path}.scalar", "ScalarOps", 1, path, {"type": "scalar", "node": nid})
        t.add_resource(f"{path}.complete", "ScalarOps", 1, path,
                       {"type": "complete", "node": nid})
        for bus in buses:
            self.attach(bus, "neutrino", path, "neutrino", "both")

    def link_resources(self, path: str, bw: float, hubs: tuple[str, str],
                       parents: tuple[str, str]) -> dict[tuple[bool, str], int]:
        """The ab and ba resources of the data link and the control link of `path` (created
        before the node's Neutrino ports, as r2-sim does)."""
        out = {}
        for ctl, hub, parent in ((False, hubs[0], parents[0]), (True, hubs[1], parents[1])):
            lpath = f"{path}.{link_name(hub, parent)}"
            for d in ("ab", "ba"):
                out[(ctl, d)] = self.t.add_resource(f"{lpath}.{d}", "Bandwidth", bw, path,
                                                    {"type": "link", "link": None, "dir": d})
        return out

    def links(self, path: str, hubs: tuple[str, str], parents: tuple[str, str],
              ids: dict[tuple[bool, str], int], bw: float, latency: int) -> None:
        """The data link `<path>.<hub>_to_<parent bus>` and the control link; each attaches
        under its name on the child's hub bus and as `<child>.<name>` on the parent bus
        (trace-raw 3.1.1)."""
        t = self.t
        child = path.rsplit(".", 1)[1]
        for ctl, hub, parent in ((False, hubs[0], parents[0]), (True, hubs[1], parents[1])):
            name = link_name(hub, parent)
            lpath = f"{path}.{name}"
            a = len(t.attachments)
            self.attach(hub, name, lpath, "link", "both")
            b = len(t.attachments)
            self.attach(parent, f"{child}.{name}", lpath, "link", "both")
            lid = len(t.links)
            t.links.append({"id": lid, "path": lpath, "node": t.node_id[path], "control": ctl,
                            "from_bus": t.bus_id[hub], "to_bus": t.bus_id[parent],
                            "from_attachment": a, "to_attachment": b,
                            "ab": ids[(ctl, "ab")], "ba": ids[(ctl, "ba")], "bw_bytes": float(bw),
                            "beat_bytes": BEAT_BYTES, "latency": latency, "cache": None})
            for d in ("ab", "ba"):
                t.resources[ids[(ctl, d)]]["role"] = {"type": "link", "link": lid, "dir": d}

    def memory(self, path: str, node: str, mtype: str, rng: tuple[int, int], base: int,
               slaves: list[str], bw: float, latency: int) -> None:
        port = self.t.add_resource(f"{path}.port", "Bandwidth", bw, node,
                                   {"type": "mem_port", "memory": None})
        self.memories.append(_Memory(path, node, mtype,
                                     [[hex(base + rng[0]), hex(base + rng[1])]],
                                     slaves, port, bw, latency))

    def sync_memory(self, node: str, base: int) -> None:
        self.memories.append(_Memory(f"{node}.sync", node, "sync",
                                     [[hex(base + SYNC_RANGE[0]), hex(base + SYNC_RANGE[1])]],
                                     [], None, None, 0))

    def pe(self, path: str, node: str, ptype: str, masters: list[str],
           resource: tuple[str, str, int] | None) -> None:
        t = self.t
        pid = len(t.pes)
        t.pes.append({"id": pid, "path": path, "node": t.node_id[node], "type": ptype})
        t.pe_id[path] = pid
        if resource is not None:
            name, kind, rate = resource
            t.add_resource(f"{path}.{name}", kind, rate, node, {"type": "pe", "pe": pid})
        for bus in masters:
            self.attach(bus, path.rsplit(".", 1)[1], path, "compute", "master")

    def finish(self) -> Topology:
        """Memory attachments and their rated ports, the null-rate ports, memory ids."""
        t = self.t
        ordered = ([m for m in self.memories if m.mtype != "sync"]
                   + [m for m in self.memories if m.mtype == "sync"])
        for mid, m in enumerate(ordered):
            atts = []
            for bus in m.slaves:
                aid = t.add_attachment(bus, m.path.rsplit(".", 1)[1], m.path, "memory", "slave")
                if t.bus_rate(bus) is not None:
                    t.add_ports(aid, rated=True)
                atts.append(aid)
            if m.port is not None:
                t.resources[m.port]["role"] = {"type": "mem_port", "memory": mid}
            t.memories.append({"id": mid, "path": m.path, "node": t.node_id[m.node],
                               "type": m.mtype, "ranges": m.ranges, "attachments": atts,
                               "port": m.port, "bw_bytes": m.bw, "latency": m.latency})
        for att in t.attachments:
            if att["in"] is None:
                t.add_ports(att["id"], rated=False)
        return t


def build(gpcs: int = GPCS, sms: int = SMS_PER_GPC) -> Topology:
    """The 2p topology: root, 2 gpcs, 4 SMs per gpc (other sizes: a 2p-like variant)."""
    b = _Builder()
    t = b.t
    t.gpcs, t.sms, t.sm_bits = gpcs, sms, max(3, sms.bit_length())
    t.add_node("root", None, NEUTRINO)
    t.add_bus("root.sbus", "root", False, 512.0)
    t.add_bus("root.cbus", "root", True, 64.0)
    b.neutrino("root", ["root.cbus", "root.sbus"])
    b.sync_memory("root", own_base(None, None, t.sm_bits))
    for g in range(gpcs):
        gpc = f"root.gpc{g}"
        t.add_node(gpc, "root", NEUTRINO_GPC)
        t.add_bus(f"{gpc}.clsbus", gpc, False, 512.0)
        t.add_bus(f"{gpc}.clcbus", gpc, True, 64.0)
        hubs, parents = (f"{gpc}.clsbus", f"{gpc}.clcbus"), ("root.sbus", "root.cbus")
        ids = b.link_resources(gpc, GPC_LINK_BW, hubs, parents)
        b.neutrino(gpc, [f"{gpc}.clcbus", f"{gpc}.clsbus"])
        b.links(gpc, hubs, parents, ids, GPC_LINK_BW, GPC_LINK_LATENCY)
        b.memory(f"{gpc}.hbm", gpc, "dram", HBM_RANGE, own_base(g, None, t.sm_bits),
                 [f"{gpc}.clsbus"], 512.0, 200)
        b.sync_memory(gpc, own_base(g, None, t.sm_bits))
        b.pe(f"{gpc}.dma", gpc, "dma", [f"{gpc}.clsbus"], None)
        for s in range(sms):
            sm = f"{gpc}.sm{s}"
            t.add_node(sm, gpc, NEUTRINO)
            for bus, ctl in (("smsbus", False), ("smcbus", True), ("lbus", False)):
                t.add_bus(f"{sm}.{bus}", sm, ctl, None)
            hubs, parents = (f"{sm}.smsbus", f"{sm}.smcbus"), (f"{gpc}.clsbus", f"{gpc}.clcbus")
            ids = b.link_resources(sm, SM_LINK_BW, hubs, parents)
            b.neutrino(sm, [f"{sm}.smcbus", f"{sm}.lbus", f"{sm}.smsbus"])
            b.links(sm, hubs, parents, ids, SM_LINK_BW, SM_LINK_LATENCY)
            b.memory(f"{sm}.smem", sm, "scratch", SMEM_RANGE, own_base(g, s, t.sm_bits),
                     [f"{sm}.lbus", f"{sm}.smsbus"], 256.0, 10)
            b.sync_memory(sm, own_base(g, s, t.sm_bits))
            b.pe(f"{sm}.atlas", sm, "tensor", [f"{sm}.lbus"], ("array", "TensorOps", 16384))
            b.pe(f"{sm}.muon", sm, "vector", [f"{sm}.lbus", f"{sm}.smsbus"],
                 ("vector", "VectorOps", 256))
            b.pe(f"{sm}.dma", sm, "dma", [f"{sm}.lbus", f"{sm}.smsbus"], None)
    return b.finish()
