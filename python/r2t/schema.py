"""Plain-words descriptions of the r2t tables and columns (trace-format.md Section 3).

The converter copies these into manifest.json, so that an agent can read the schema from
the trace itself. Label field columns are described from the raw manifest's label schema.
"""

from __future__ import annotations

from .dims import NEUTRINO_TABLES

TABLES: dict[str, tuple[str, dict[str, str]]] = {
    "nodes": ("Neutrino nodes of the design tree (one Neutrino per node).", {
        "id": "node id (= NeutrinoId)",
        "path": "dotted path from the root, e.g. root.gpc0.sm1",
        "name": "last component of the path",
        "parent": "id of the parent node; NULL for the root",
        "depth": "0 for the root, parent depth + 1 otherwise",
        **{f"cap_{t}": f"entries of the Neutrino's {t.replace('_', ' ')} table; NULL if the "
           "dump has no capacities"
           for t in NEUTRINO_TABLES},
    }),
    "pes": ("Processing engines on which tasks execute.", {
        "id": "PE id (= PeId)",
        "path": "dotted path of the PE",
        "node": "node id that owns the PE",
        "type": "tensor, vector or dma",
    }),
    "lanes": ("Task timeline lanes: one per PE and one per Neutrino (tasks without a PE).", {
        "id": "lane id; lanes are in node order, the Neutrino lane first",
        "path": "PE path, or the node path + '.neutrino' for a Neutrino lane",
        "node": "node id",
        "pe": "PE id; NULL for a Neutrino lane",
        "type": "neutrino, or the PE type",
    }),
    "buses": ("Buses (fabrics) of the design.", {
        "id": "bus id",
        "path": "dotted path of the bus",
        "node": "node id that owns the bus",
        "topology": "xbar, bus or ring",
        "control": "true for a control bus (protocol messages)",
        "bw_bytes": "bytes per cycle per port; NULL if unlimited",
        "latency": "bus latency in cycles",
        "class": "link class: global, local or control (trace-format Section 5)",
    }),
    "attachments": ("Attachments of components to buses.", {
        "id": "attachment id",
        "bus": "bus id",
        "name": "port name on the bus, e.g. sm1, hbm, neutrino, bridge",
        "component": "path of the attached component",
        "component_type": "memory, neutrino, bridge or compute",
        "role": "master, slave or both",
        "in_resource": "resource id of the ingress port (component into bus); NULL if none",
        "out_resource": "resource id of the egress port (bus to component); NULL if none",
    }),
    "bridges": ("Bridges between buses: child bridges and caches.", {
        "id": "bridge id",
        "path": "dotted path of the bridge",
        "type": "child or cache",
        "a_attachment": "attachment id on side a (the child bus for a child bridge)",
        "b_attachment": "attachment id on side b (the parent bus for a child bridge)",
        "a_bus": "bus id of side a",
        "b_bus": "bus id of side b",
        "ab_resource": "resource id of direction a to b (up for a child bridge)",
        "ba_resource": "resource id of direction b to a (down for a child bridge)",
        "latency": "bridge latency in cycles",
    }),
    "memories": ("Memories of the design.", {
        "id": "memory id",
        "path": "dotted path of the memory",
        "node": "node id that owns the memory",
        "type": "scratch, dram, cache or sync",
        "port": "resource id of the memory port; NULL if none",
        "bw_bytes": "port bytes per cycle; NULL if none",
        "latency": "access latency in cycles; NULL if none",
    }),
    "memory_ranges": ("Global address ranges of the memories.", {
        "memory": "memory id",
        "lo": "first address of the range",
        "hi": "end of the range (exclusive)",
    }),
    "resources": ("Simulator resources: links, memory ports, PEs, Neutrino scalar and "
                  "completion ports. A charge uses one resource.", {
        "id": "resource id (= ResourceId)",
        "name": "dotted name, e.g. root.gpc0.clsbus.sm1.in",
        "node": "owner node id",
        "kind": "TensorOps, VectorOps, ScalarOps, Bandwidth or Slots",
        "unit": "unit of amount: MAC, lane-op, instr, B or slot",
        "rate": "units per cycle; NULL if unlimited",
        "ceiling": "100 % line in units per cycle: the rate, or for an unlimited link the "
                   "peak instantaneous throughput over the run (NULL if no charge)",
        "role": "port, bus, bridge, mem_port, pe, scalar, complete or other",
        "bus": "bus id for a port or a bus resource",
        "attachment": "attachment id for a port",
        "bridge": "bridge id for a bridge direction",
        "memory": "memory id for a memory port",
        "pe": "PE id for a PE resource",
        "link_dir": "in or out for a port, up or down for a bridge direction",
        "is_link": "true for ports, buses and bridge directions",
        "class": "global, local, control (links and memory ports), compute (PEs) or "
                 "scalar (Neutrino scalar and completion ports)",
        "busy_cycles": "sum of charge cycles over the dump",
        "amount": "sum of charge amounts over the dump",
    }),
    "opcodes": ("Opcode names.", {"id": "opcode", "name": "opcode name"}),
    "message_kinds": ("Protocol message kind names.", {"id": "msg code", "name": "kind name"}),
    "dirs": ("Charge direction names.", {"id": "dir code", "name": "read, write or work"}),
    "dep_states": ("Producer state at the consumer's invoke.", {
        "id": "state code",
        "name": "not_invoked, scoreboard, executing or done",
    }),
    "tasks": ("One row per task, sorted by gid.", {
        "gid": "task id, in invoke order",
        "nu": "node id of the Neutrino whose tables track the task (owner of dst)",
        "src_nu": "node id of the Neutrino whose program called invoke; differs from nu "
                  "for a forwarded invoke",
        "pe": "executing PE; NULL for join and spawn",
        "lane": "lane id: the PE's lane, or the Neutrino lane of nu",
        "opcode": "opcode id",
        "label": "descriptor label (raw 64-bit value); NULL if none",
        "version": "version of a versioned dst; NULL if unversioned",
        "dst_base": "destination range base (global address)",
        "dst_len": "destination range length in bytes",
        "call": "cycle the program issued the invoke call (before c_invoke and any stall)",
        "invoke": "entry into the scoreboard of nu; arrival at nu for a forwarded invoke",
        "ready": "the last dependency resolved; NULL if never",
        "issue": "entry into the execution table; NULL if never",
        "complete": "completion reached the tables; NULL if never",
        "retire": "the entry left the tables; NULL if never",
        "queued": "forwarded invoke: entry into the outbound invoke table of src_nu",
        "sent": "forwarded invoke: the Invoke message left onto the channel",
        "n_chunks": "number of chunk rows of the task",
        "n_deps": "number of dependency rows of the task",
    }),
    "chunks": ("One row per chunk, sorted by (gid, idx).", {
        "gid": "task id",
        "idx": "chunk index in the task, from 0 in request order",
        "start": "first cycle of the chunk's demand",
        "end": "end of the chunk (exclusive)",
        "culprit": "service culprit: resource with the longest own duration; NULL if none",
        "queue_culprit": "resource whose earliest start delayed the chunk most; NULL if no "
                         "delay",
    }),
    "deps": ("One row per dependency range of a task, sorted by (consumer, idx).", {
        "consumer": "gid of the task that has the dependency",
        "idx": "dependency index in the descriptor",
        "producer": "gid of the task whose dst the dependency resolved to; NULL if a store "
                    "wrote the range or no task did. Can refer to a task outside a partial "
                    "trace",
        "state": "producer state at the consumer's invoke (dep_states)",
        "remote": "true if the range is owned by a Neutrino other than the consumer's nu",
        "versioned": "true for a versioned dependency",
        "resolved": "cycle the dependency counted as resolved at the consumer; NULL if never",
    }),
    "programs": ("One row per program run on a Neutrino, sorted by (nu, start).", {
        "nu": "node id",
        "name": "program name",
        "spawn": "gid of the spawn task in the parent; NULL for the root program",
        "start": "cycle the program started",
        "end": "cycle the program returned; NULL if never",
    }),
    "charges": ("One row per charge of a resource and direction. Row group = time block "
                "(manifest.charge_blocks); sorted by (block, resource, start).", {
        "resource": "resource id",
        "start": "first cycle of the charge",
        "end": "start + span: end of the whole charge (exclusive)",
        "cycles": "cycles of this direction; the rows of one charge sum to end - start. "
                  "On an unlimited link equal to end - start",
        "amount": "units of this direction (resources.unit)",
        "dir": "direction code (dirs)",
        "gid": "task whose chunk made the charge; NULL for a protocol message, a load, a "
               "store or scalar program work",
        "msg": "message kind code for a protocol message; NULL otherwise",
    }),
    "bins": ("Overview bins: charges spread evenly over fixed-width time bins; only "
             "non-empty bins. Sorted by (resource, dir, bin).", {
        "resource": "resource id",
        "dir": "direction code",
        "bin": "bin index; the bin starts at bin * manifest.bins.width (v_bins adds it as t)",
        "busy": "busy cycles in the bin, rounded to whole cycles (can exceed the width on "
                "an unlimited link)",
        "amount": "units moved in the bin (float32); on a rated link it can exceed "
                  "rate * width by up to one cycle of the rate (calendar carry)",
    }),
    "marks": ("Program marks, sorted by time.", {
        "time": "cycle of the mark",
        "name": "mark name",
        "nu": "node id of the program that made the mark; NULL if none",
    }),
    "phases": ("Phases from the run summary, sorted by start.", {
        "stage": "stage name",
        "name": "phase name",
        "layer": "layer index",
        "start": "first cycle",
        "end": "end cycle",
        "estimate": "cost-model estimate in cycles",
        "roofline": "roofline bound in cycles",
        "bound_by": "the resource class that bounds the roofline",
    }),
}


def describe(table: str, rows: int, label_fields: list[dict]) -> dict:
    """The manifest entry of one table."""
    description, columns = TABLES[table]
    columns = dict(columns)
    if table == "tasks":
        ordered = {}
        for name, text in columns.items():
            ordered[name] = text
            if name == "label":
                for f in label_fields:
                    kind = "name" if "enum" in f else "value"
                    ordered[f["name"]] = (f"label field {f['name']} ({kind}; bits "
                                          f"{f['shift']}..{f['shift'] + f['bits'] - 1})")
        columns = ordered
    return {"rows": rows, "description": description, "columns": columns}
