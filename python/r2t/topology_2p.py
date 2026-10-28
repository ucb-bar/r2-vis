"""The topology of r2-sim configs/2p-smem.yaml (2p.yaml before 2026-10-27) as manifest
tables (trace-raw.md Section 3.1).

The tables follow r2-sim's raw 1.2 dump of that config entry for entry:

* nodes, buses and PEs depth-first over the node tree;
* attachments per node in creation order (Neutrino, data link, control link,
  compute masters), then the memory attachments of the whole tree;
* rated resources per node in creation order (link directions, Neutrino, bus ports,
  memory port,
  PEs), then the rated ports of the memory attachments;
* then the ports with `rate: null`, in attachment order: every attachment of an
  unlimited bus, and the compute masters on a rated xbar;
* memories: the memories with a port depth-first, then the sync memories.

Variants of later configs (2026-10-09):

* `rw` (configs/2p-smem.yaml, raw 1.5): separate write channels at the read
  rate on the rated data buses (sbus, clsbus) and data links (`<port>.in.wr` after the
  port's in/out, `<link>.ab.wr`, `.ba.wr` after the link's ab/ba), and an SMEM write port
  (`smem.wport` after `smem.port`); HBM of 4 GiB.
* `banks` (the former configs/2p-hbm-sliced.yaml, raw 1.4): offset_bits 34;
  per gpc an unlimited `hbmbus`, the link `clsbus_to_hbmbus` with an address hash from
  the linear HBM [0, 4 GiB) onto N banks `hbm.b<i>` at [8 GiB, 12 GiB), each with a port
  and a write port of 512 / N B/cycle on the hbmbus. The unlimited link's resources are
  created last, after the ports with `rate: null`.
"""

from __future__ import annotations

import math

from dataclasses import dataclass, field

GPCS = 2
SMS_PER_GPC = 4
GPC_LINK_BW, GPC_LINK_LATENCY = 256, 20
SM_LINK_BW, SM_LINK_LATENCY = 128, 10
SYNC_RANGE = (0x1F0000000, 0x1F1000000)
HBM_RANGE = (0x0, 0xF0000000)         # 2p.yaml before 2026-10-09 (lanesB/l1)
HBM_RANGE_4G = (0x0, 0x100000000)      # 2p-smem.yaml, and 2p-hbm-sliced.yaml (removed)
BANKED_RANGE = (0x200000000, 0x300000000)
HBM_BW, HBM_LATENCY = 512.0, 200
GRANULE = 512                          # global.neutrino_granule: the hash interleave
SMEM_RANGE = (0x0, 0x100000)
BEAT_BYTES = 64             # r2-sim default beat of ports, links and memory ports
# Neutrino table capacities (2p-smem.yaml, gpc-smem.yaml, sm-smem.yaml): gpcs have 1024 versions.
NEUTRINO = {"scoreboard": 128, "pending": 256, "execution": 256, "versions": 256,
            "inbound_refs": 128, "inbound_invokes": 64, "outbound_deps": 128,
            "outbound_invokes": 32}
NEUTRINO_GPC = {**NEUTRINO, "versions": 1024}


def link_name(from_bus: str, to_bus: str) -> str:
    """The r2-sim link name `<from bus>_to_<to bus>` (last path components)."""
    return f"{from_bus.rsplit('.', 1)[1]}_to_{to_bus.rsplit('.', 1)[1]}"


def own_base(gpc: int | None, sm: int | None, sm_bits: int = 3, offset_bits: int = 33) -> int:
    """Base of a node's own address space (2p-smem.yaml: offset_bits 33, fields gpc:2, sm:3; a
    larger variant widens the sm field; the former 2p-hbm-sliced.yaml: offset_bits 34)."""
    base = 0
    if gpc is not None:
        base |= (gpc + 1) << (offset_bits + sm_bits)
    if sm is not None:
        base |= (sm + 1) << offset_bits
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
    offset_bits: int = 33
    rw: bool = False
    banks: int = 0
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

    def base(self, gpc: int | None, sm: int | None) -> int:
        return own_base(gpc, sm, self.sm_bits, self.offset_bits)

    def add_bus(self, path: str, node: str, control: bool, bw: float | None,
                wr: float | None = None) -> None:
        self.bus_id[path] = len(self.buses)
        bus = {"id": len(self.buses), "path": path, "node": self.node_id[node],
               "topology": "xbar", "control": control, "bw_bytes": bw, "latency": 0}
        if wr is not None:
            bus["wr_bytes"] = wr
        self.buses.append(bus)

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
        # A rated port of a bus with separate write channels (raw 1.5).
        if rated and bus.get("wr_bytes") is not None:
            for direction in ("in", "out"):
                att[f"{direction}_wr"] = self.add_resource(
                    f"{bus['path']}.{att['name']}.{direction}.wr", "Bandwidth", bus["wr_bytes"],
                    owner, {"type": "port", "attachment": aid, "dir": direction, "write": True})


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
    wport: int | None = None
    wr: float | None = None


class _Builder:
    """Builds the 2p tables in r2-sim's creation order."""

    def __init__(self) -> None:
        self.t = Topology()
        self.memories: list[_Memory] = []
        # unlimited links: their resources are created last (after the null-rate ports)
        self.unlimited_links: list[int] = []

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
        before the node's Neutrino ports, as r2-sim does); with write channels, the data
        link's ab.wr and ba.wr after its ab and ba."""
        out = {}
        for ctl, hub, parent in ((False, hubs[0], parents[0]), (True, hubs[1], parents[1])):
            lpath = f"{path}.{link_name(hub, parent)}"
            for d in ("ab", "ba"):
                out[(ctl, d)] = self.t.add_resource(f"{lpath}.{d}", "Bandwidth", bw, path,
                                                    {"type": "link", "link": None, "dir": d})
            if self.t.rw and not ctl:
                for d in ("ab", "ba"):
                    out[(ctl, f"{d}_wr")] = self.t.add_resource(
                        f"{lpath}.{d}.wr", "Bandwidth", bw, path,
                        {"type": "link", "link": None, "dir": d, "write": True})
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
            link = {"id": lid, "path": lpath, "node": t.node_id[path], "control": ctl,
                    "from_bus": t.bus_id[hub], "to_bus": t.bus_id[parent],
                    "from_attachment": a, "to_attachment": b,
                    "ab": ids[(ctl, "ab")], "ba": ids[(ctl, "ba")], "bw_bytes": float(bw),
                    "beat_bytes": BEAT_BYTES, "latency": latency, "cache": None}
            t.links.append(link)
            for d in ("ab", "ba"):
                t.resources[ids[(ctl, d)]]["role"] = {"type": "link", "link": lid, "dir": d}
                if (ctl, f"{d}_wr") in ids:
                    link[f"{d}_wr"] = ids[(ctl, f"{d}_wr")]
                    t.resources[link[f"{d}_wr"]]["role"] = {"type": "link", "link": lid,
                                                            "dir": d, "write": True}
            if (ctl, "ab_wr") in ids:
                link["wr_bytes"] = float(bw)

    def hash_link(self, gpc: str, base: int) -> None:
        """The unlimited link `<gpc>.clsbus_to_hbmbus` that spreads the linear HBM onto the
        banks (gpc-hbm-sliced.yaml); its ab and ba resources come at the end."""
        t = self.t
        name = "clsbus_to_hbmbus"
        lpath = f"{gpc}.{name}"
        a = len(t.attachments)
        self.attach(f"{gpc}.clsbus", name, lpath, "link", "both")
        b = len(t.attachments)
        self.attach(f"{gpc}.hbmbus", name, lpath, "link", "both")
        bits = t.banks.bit_length() - 1
        to_lo, to_hi = base + BANKED_RANGE[0], base + BANKED_RANGE[1]
        lid = len(t.links)
        t.links.append({"id": lid, "path": lpath, "node": t.node_id[gpc], "control": False,
                        "from_bus": t.bus_id[f"{gpc}.clsbus"], "to_bus": t.bus_id[f"{gpc}.hbmbus"],
                        "from_attachment": a, "to_attachment": b, "ab": None, "ba": None,
                        "bw_bytes": None, "beat_bytes": BEAT_BYTES, "latency": 0, "cache": None,
                        "hash": {"range": [hex(base + lo) for lo in HBM_RANGE_4G],
                                 "to_range": [hex(to_lo), hex(to_hi)],
                                 "index": [hex(GRANULE << j) for j in range(bits)],
                                 "drop": [GRANULE.bit_length() - 1 + j for j in range(bits)],
                                 "granule": GRANULE, "slice_bytes": (to_hi - to_lo) // t.banks}})
        self.unlimited_links.append(lid)

    def memory(self, path: str, node: str, mtype: str, rng: tuple[int, int], base: int,
               slaves: list[str], bw: float, latency: int, wr: float | None = None) -> None:
        """A memory with its port; with `wr`, a write port `<path>.wport` after it."""
        port = self.t.add_resource(f"{path}.port", "Bandwidth", bw, node,
                                   {"type": "mem_port", "memory": None})
        wport = None if wr is None else self.t.add_resource(
            f"{path}.wport", "Bandwidth", wr, node,
            {"type": "mem_port", "memory": None, "write": True})
        self.memories.append(_Memory(path, node, mtype,
                                     [[hex(base + rng[0]), hex(base + rng[1])]],
                                     slaves, port, bw, latency, wport, wr))

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
            mem = {"id": mid, "path": m.path, "node": t.node_id[m.node], "type": m.mtype,
                   "ranges": m.ranges, "attachments": atts, "port": m.port, "bw_bytes": m.bw,
                   "latency": m.latency}
            if m.wport is not None:
                t.resources[m.wport]["role"] = {"type": "mem_port", "memory": mid, "write": True}
                mem["wport"], mem["wr_bytes"] = m.wport, m.wr
            t.memories.append(mem)
        for att in t.attachments:
            if att["in"] is None:
                t.add_ports(att["id"], rated=False)
        for lid in self.unlimited_links:
            link = t.links[lid]
            owner = t.nodes[link["node"]]["path"]
            for d in ("ab", "ba"):
                link[d] = t.add_resource(f"{link['path']}.{d}", "Bandwidth", None, owner,
                                         {"type": "link", "link": lid, "dir": d})
        return t


def build(gpcs: int = GPCS, sms: int = SMS_PER_GPC, acc: bool = False, rw: bool = False,
          banks: int = 0) -> Topology:
    """The 2p topology: root, 2 gpcs, 4 SMs per gpc (other sizes: a 2p-like variant). With
    `acc`, each gpc also has a child node `acc0` of another kind (its Neutrino and a DMA
    engine on its own buses, linked to the gpc as an SM is), to test views that group
    siblings by kind; the workload does not use it. `rw` and `banks` (a power of two):
    the variants of the module docstring."""
    if banks and banks & (banks - 1):
        raise ValueError(f"banks must be a power of two, not {banks}")
    b = _Builder()
    t = b.t
    t.gpcs, t.sms, t.sm_bits = gpcs, sms, max(3, sms.bit_length())
    t.rw, t.banks, t.offset_bits = rw, banks, 34 if banks else 33
    data_wr = 512.0 if rw else None
    t.add_node("root", None, NEUTRINO)
    t.add_bus("root.sbus", "root", False, 512.0, data_wr)
    t.add_bus("root.cbus", "root", True, 64.0)
    b.neutrino("root", ["root.cbus", "root.sbus"])
    b.sync_memory("root", t.base(None, None))
    for g in range(gpcs):
        gpc = f"root.gpc{g}"
        t.add_node(gpc, "root", NEUTRINO_GPC)
        t.add_bus(f"{gpc}.clsbus", gpc, False, 512.0, data_wr)
        t.add_bus(f"{gpc}.clcbus", gpc, True, 64.0)
        if banks:
            t.add_bus(f"{gpc}.hbmbus", gpc, False, None)
        hubs, parents = (f"{gpc}.clsbus", f"{gpc}.clcbus"), ("root.sbus", "root.cbus")
        ids = b.link_resources(gpc, GPC_LINK_BW, hubs, parents)
        b.neutrino(gpc, [f"{gpc}.clcbus", f"{gpc}.clsbus"] + ([f"{gpc}.hbmbus"] if banks else []))
        b.links(gpc, hubs, parents, ids, GPC_LINK_BW, GPC_LINK_LATENCY)
        if banks:
            b.hash_link(gpc, t.base(g, None))
            size = (BANKED_RANGE[1] - BANKED_RANGE[0]) // banks
            for i in range(banks):
                lo = BANKED_RANGE[0] + i * size
                b.memory(f"{gpc}.hbm.b{i}", gpc, "dram", (lo, lo + size), t.base(g, None),
                         [f"{gpc}.hbmbus"], HBM_BW / banks, HBM_LATENCY, HBM_BW / banks)
        else:
            b.memory(f"{gpc}.hbm", gpc, "dram", HBM_RANGE_4G if rw else HBM_RANGE,
                     t.base(g, None), [f"{gpc}.clsbus"], HBM_BW, HBM_LATENCY)
        b.sync_memory(gpc, t.base(g, None))
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
            b.memory(f"{sm}.smem", sm, "scratch", SMEM_RANGE, t.base(g, s),
                     [f"{sm}.lbus", f"{sm}.smsbus"], 256.0, 10, 256.0 if rw else None)
            b.sync_memory(sm, t.base(g, s))
            b.pe(f"{sm}.atlas", sm, "tensor", [f"{sm}.lbus"], ("array", "TensorOps", 16384))
            b.pe(f"{sm}.muon", sm, "vector", [f"{sm}.lbus", f"{sm}.smsbus"],
                 ("vector", "VectorOps", 256))
            b.pe(f"{sm}.dma", sm, "dma", [f"{sm}.lbus", f"{sm}.smsbus"], None)
        if acc:
            _acc_node(b, gpc, g, sms)
    return b.finish()


def _acc_node(b: _Builder, gpc: str, g: int, index: int) -> None:
    """The extra child `<gpc>.acc0`: buses named as an SM's (the control routes use
    smcbus at depth 2), a Neutrino, a DMA engine and a sync memory."""
    t = b.t
    node = f"{gpc}.acc0"
    t.add_node(node, gpc, NEUTRINO)
    for bus, ctl in (("smsbus", False), ("smcbus", True)):
        t.add_bus(f"{node}.{bus}", node, ctl, None)
    hubs, parents = (f"{node}.smsbus", f"{node}.smcbus"), (f"{gpc}.clsbus", f"{gpc}.clcbus")
    ids = b.link_resources(node, SM_LINK_BW, hubs, parents)
    b.neutrino(node, [f"{node}.smcbus", f"{node}.smsbus"])
    b.links(node, hubs, parents, ids, SM_LINK_BW, SM_LINK_LATENCY)
    b.sync_memory(node, t.base(g, index))
    b.pe(f"{node}.dma", node, "dma", [f"{node}.smsbus"], None)
