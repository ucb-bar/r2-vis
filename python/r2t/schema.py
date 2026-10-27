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
        "wr_bytes": "write channel bytes per cycle per port (raw 1.5): the bus has separate "
                    "read and write channels; NULL if not split",
    }),
    "attachments": ("Attachments of components to buses.", {
        "id": "attachment id",
        "bus": "bus id",
        "name": "port name on the bus, e.g. sm1, hbm, neutrino, smsbus_to_clsbus, "
                "sm0.smsbus_to_clsbus (a link end on the parent bus)",
        "component": "path of the attached component",
        "component_type": "memory, neutrino, link or compute",
        "role": "master, slave or both",
        "in_resource": "resource id of the ingress port (component into bus); NULL if none",
        "out_resource": "resource id of the egress port (bus to component); NULL if none",
        "in_wr_resource": "write channel of the ingress port (raw 1.5); NULL if not split",
        "out_wr_resource": "write channel of the egress port (raw 1.5); NULL if not split",
    }),
    "links": ("Fabric links between buses (trace-raw 3.1.1); a raw 1.0 or 1.1 bridge is a "
              "link from its child side to its parent side.", {
        "id": "link id",
        "path": "link name, by convention <from bus>_to_<to bus>",
        "node": "node whose fabric lists the link",
        "control": "true for a control link",
        "from_bus": "bus id of the from end",
        "to_bus": "bus id of the to end",
        "from_attachment": "attachment id of the from end",
        "to_attachment": "attachment id of the to end",
        "ab_resource": "resource id of direction from -> to",
        "ba_resource": "resource id of direction to -> from",
        "up_dir": "ab or ba: the direction toward the ancestor's bus; NULL if the ends are on "
                  "the same node or on unrelated nodes",
        "bw_bytes": "bytes per cycle per direction; NULL if unlimited",
        "beat_bytes": "bytes per beat; NULL if not given",
        "latency": "link latency in cycles",
        "cache": "memory id when the link is a cache; NULL otherwise",
        "class": "global, local or control (Section 5); a cache link: its memory port's class",
        "hash_lo": "hashed link (raw 1.4): first address of the linear range it rewrites; "
                   "NULL without a hash",
        "hash_hi": "end of that range (exclusive)",
        "hash_to_lo": "first address of the banked range it maps onto",
        "hash_to_hi": "end of the banked range (exclusive)",
        "hash_index": "masks as comma-separated hex, e.g. 0x200,0x400: bank bit j = "
                      "parity(address & mask j)",
        "hash_drop": "comma-separated address bit positions dropped after the bank bits are "
                     "taken, e.g. 9,10",
        "hash_granule": "bytes per interleave granule",
        "hash_slice_bytes": "bytes of one bank's slice of the banked range",
        "wr_bytes": "write channel bytes per cycle per direction (raw 1.5); NULL if not split",
        "ab_wr_resource": "write channel of direction from -> to; NULL if not split",
        "ba_wr_resource": "write channel of direction to -> from; NULL if not split",
    }),
    "memories": ("Memories of the design.", {
        "id": "memory id",
        "path": "dotted path of the memory",
        "node": "node id that owns the memory",
        "type": "scratch (SMEM), tmem (an SM's tensor memory), nu_scratch (a Neutrino's data "
                "scratch, raw 1.10), dram, "
                "cache or sync",
        "port": "resource id of the memory port; NULL if none",
        "bw_bytes": "port bytes per cycle; NULL if none",
        "latency": "access latency in cycles; NULL if none",
        "wport": "resource id of a separate write port (raw 1.4); NULL if none",
        "wr_bytes": "write port bytes per cycle; NULL if none",
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
        "capacity": "slots per core cycle (format 1.6): rate / beat_bytes for a "
                    "bandwidth resource, the clock for a compute PE; charges hold fractions "
                    "of it. Raw 1.6 and older dumps: the lanes. NULL if unlimited. Not related "
                    "to the lanes table (task timeline lanes)",
        "clock": "the resource's clock relative to the core clock (format 1.6; 1 before)",
        "beat_bytes": "bytes per beat of a bandwidth resource; NULL otherwise, if unlimited "
                      "and for raw 1.0 dumps",
        "ceiling": "100 % line in units per cycle: the rate, or for an unlimited link the "
                   "peak instantaneous throughput over the run (NULL if no charge)",
        "role": "port, bus, link, mem_port, pe, scalar, complete or other",
        "bus": "bus id for a port or a bus resource",
        "attachment": "attachment id for a port",
        "link": "link id for a link direction",
        "memory": "memory id for a memory port",
        "pe": "PE id for a PE resource",
        "link_dir": "in or out for a port; up or down for a link direction with a hierarchy "
                    "direction (links.up_dir), else ab or ba",
        "is_link": "true for ports, buses and link directions",
        "write": "true for a memory write port or a write channel (raw 1.4, 1.5)",
        "class": "global, local, control (links and memory ports), compute (PEs) or "
                 "scalar (Neutrino scalar and completion ports)",
        "busy_cycles": "sum of charge slot-cycles over the dump, rounded",
        "amount": "sum of charge amounts over the dump",
    }),
    "rate_classes": ("Rate classes of compute resources whose rate depends on the operand "
                     "type (format 1.6, raw 1.7 rates); a mixed-type operation runs at the "
                     "class of its slower operand.", {
        "resource": "resource id",
        "class": "class index (charges.class, bins.class)",
        "name": "class name, e.g. bf16, fp8, mxfp4",
        "rate": "units per core cycle of this class",
    }),
    "opcodes": ("Opcode names.", {"id": "opcode", "name": "opcode name"}),
    "message_kinds": ("Protocol message kind names.", {"id": "msg code", "name": "kind name"}),
    "dirs": ("Charge direction names.", {"id": "dir code", "name": "read, write or work"}),
    "dep_states": ("Producer state at the consumer's invoke.", {
        "id": "state code",
        "name": "not_invoked, scoreboard, executing or done",
    }),
    "table_names": ("Neutrino table names of the entries table.", {
        "id": "table code",
        "name": "pending, versions, inbound_refs, inbound_invokes, outbound_deps or "
                "outbound_invokes",
    }),
    "entries": ("Entries of the six Neutrino tables that the tasks do not give (trace-raw "
                "4.7), sorted by (nu, table, start). The occupancy of a table at t is the "
                "number of its entries with start <= t < end.", {
        "nu": "node id of the Neutrino whose table holds the entry",
        "table": "table code (table_names)",
        "start": "cycle the entry was created",
        "end": "cycle the entry was freed; NULL if still present at the end of the run",
        "base": "address: the key (pending, inbound_refs, outbound_deps), the range base "
                "(versions, inbound_invokes, outbound_invokes)",
        "len": "range length in bytes; 0 for a key, a VersionReset or nu.version",
        "version": "the key's version, the last counter (versions) or the assigned version "
                   "(inbound_invokes); NULL if unversioned",
        "gid": "the entry's task (per table, trace-raw 4.7); NULL if none",
        "peer": "the other Neutrino (requester, owner, or the VersionReset sender); NULL if "
                "none",
        "flags": "per table: pending bits 0-1 creator (0 dependency, 1 local wait, 2 remote "
                 "Await); versions bit 0 nu.version; outbound_deps bit 0 registered, bit 1 "
                 "rejected; inbound_invokes bit 0 VersionReset; outbound_invokes bit 0 "
                 "VersionReset, bit 1 replayed",
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
        "untracked": "no task can depend on it; the fence (wait 0) and the return of its "
                     "program wait for it (raw 1.8)",
        "dst_base": "destination range base (global address)",
        "dst_len": "destination span in bytes",
        "dst_mask": "destination mask in granules (manifest run.granule): granule "
                    "dst_base / granule + i of the span belongs to the range when "
                    "i & ~dst_mask = 0; 4294967295 (all ones) for a plain range (raw 1.9)",
        "pc": "IMEM offset of the nu.* instruction that made the task, in the coordinates of "
              "the program's source map (raw 1.10); NULL for a task of a program that is not "
              "an RV image",
        "program": "the program that made the task (programs.id): the program on src_nu "
                   "with start <= call < end; with pc, it names the source map item",
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
        "id": "program id: the row index (charges.program and usage.program refer to it)",
        "nu": "node id",
        "name": "program name",
        "spawn": "gid of the spawn task in the parent; NULL for the root program",
        "start": "cycle the program started",
        "end": "cycle the program returned; NULL if never",
        "image": "the RV image that the program ran (images.id, raw 1.10); NULL for a "
                 "program that is not an RV image",
    }),
    "images": ("RV images that programs ran (raw 1.10), deduplicated by sha256, in order of "
               "first use. A source map belongs to an image when its image.bytes and "
               "image.sha256 are equal.", {
        "id": "image id (programs.image)",
        "file": "the file of an --image entry, as given; NULL for an image that an IMEM "
                "copy placed",
        "imem": "the node path of the --image entry; NULL for a copied image",
        "bytes": "IMEM bytes of the image",
        "sha256": "hex SHA-256 of those bytes",
        "programs": "comma-separated names of the program records in the image",
    }),
    "usage": ("Attribution (format 1.5): the charges summed per resource, charge block and "
              "owner, sorted by (resource, block, gid, program), so that a resource's rows "
              "are contiguous. A range [a, b): the blocks inside it from here, the two edge "
              "blocks from charges, clipped; an instant t: the charges with start <= t < "
              "end (slots held = usage).", {
        "resource": "resource id",
        "block": "charge block: the index into manifest.charge_blocks (a row group of "
                 "charges.parquet; its charges start in [t0, t1) and end by max_end)",
        "gid": "owner task; NULL for a program owner or no owner",
        "program": "owner program (programs.id); NULL for a task or no owner",
        "amount": "summed amount",
        "cycles": "summed slot-cycles (DOUBLE)",
        "n": "number of charges",
        "first": "earliest start of these charges",
        "last": "latest end of these charges",
    }),
    "charges": ("One row per charge of a resource and direction. Row group = time block "
                "(manifest.charge_blocks); sorted by (block, resource, start).", {
        "resource": "resource id",
        "start": "first cycle of the charge",
        "end": "start + span: end of the whole charge (exclusive)",
        "cycles": "slot-cycles of this direction, usage x (end - start) (DOUBLE). On an "
                  "unlimited link equal to end - start",
        "usage": "slots held by this direction over the whole charge (raw 1.7 usage / 65536; "
                 "raw 1.6 and older: lane-cycles / span); the rows of one charge sum to its "
                 "usage, at most the resource's capacity",
        "class": "rate class (rate_classes.class) of a charge on a resource with rate "
                 "classes (raw 1.7); NULL otherwise",
        "amount": "units of this direction (resources.unit)",
        "dir": "direction code (dirs)",
        "gid": "owner task (raw 1.6: the task whose chunk made it, the invoked or consumer "
               "task of a protocol message, the invoked task of invoke scalar work); NULL for a "
               "program owner or no owner (a raw 1.5 or older dump: messages, loads, stores and "
               "scalar work)",
        "program": "owner program (raw 1.6): programs.id of the program whose scalar work, "
                   "load, store or message it is; NULL otherwise",
        "msg": "message kind code for a protocol message; NULL otherwise",
    }),
    "bins": ("Overview bins: charges spread evenly over fixed-width time bins; only "
             "non-empty bins. Sorted by (resource, dir, class, bin).", {
        "resource": "resource id",
        "dir": "direction code",
        "class": "rate class: a resource with rate classes has one series per (dir, class); "
                 "NULL for the others",
        "bin": "bin index; the bin starts at manifest.bins.origin + bin * manifest.bins.width "
               "(v_bins adds it as t)",
        "busy": "busy slot-cycles in the bin (FLOAT): at most capacity * width on a "
                "resource with a rate (busy fraction = busy / (capacity * width)); can exceed "
                "the width on an unlimited link",
        "amount": "units moved in the bin (float32); on a rated link at most rate * width "
                  "(traces made before 2026-10-02 can exceed it by one cycle of the rate)",
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
