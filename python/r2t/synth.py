"""Synthetic raw dumps (trace-raw.md v1.2) of a toy workload on the 2p topology.

The generator stands in for r2-sim until the real dump exists. A small discrete-event
list scheduler runs a toy workload: the root program spawns one program per gpc, each
gpc program spawns one program per SM, and each SM program runs a pipelined loop (DMA
weights and activations into SMEM, Atlas matmul, Muon vector, DMA out through the gpc
copy engine as a forwarded invoke). The timing is plausible, not exact: a PE runs one
task at a time, dependencies are respected, a rated resource has `lanes` lane calendars
without gap fill (trace-raw v1.1: a transfer holds ceil(rate / lane rate) lanes over its
span, so charges overlap up to the lane count), and unlimited links take the interval of
the chunk or message hop that uses them.

    python -m r2t.synth OUT_DIR --tasks 20000 [--seed 1] [--zstd]
    python -m r2t.synth DIR --suite          # tiny, small, medium, partial, crashed, small-zstd
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
import random
import shutil
import time
from collections import deque
from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path
from typing import Callable

import numpy as np

from r2t import raw
from r2t.topology_2p import Topology, build, link_name, own_base

OPCODES = ["join", "spawn", "dma", "atlas.matmul", "muon.vector"]
OP_JOIN, OP_SPAWN, OP_DMA, OP_MATMUL, OP_VECTOR = range(5)
KINDS = ["none", "router", "qkv", "attn", "wo", "ffn_gate", "ffn_up", "ffn_down", "vec",
         "dma_w", "dma_act", "join"]
MATMUL_KINDS = ["qkv", "attn", "wo", "ffn_gate", "ffn_up", "ffn_down"]
MSG = {name: i for i, name in enumerate(raw.MESSAGE_KINDS)}
PENDING, VERSIONS, INBOUND_REFS, INBOUND_INVOKES, OUTBOUND_DEPS, OUTBOUND_INVOKES = range(6)

C_INVOKE, C_STORE, C_RESOLVE, C_COMPLETE = 8, 4, 2, 4
MSG_BYTES, INVOKE_MSG_BYTES = 64, 128
WINDOW = 32                 # invokes in flight per program (stands in for the table sizes)
DMA_LATENCY, HBM_LATENCY, SMEM_LATENCY, MUON_OVERHEAD = 100, 200, 10, 50
CHUNK_BYTES = 64 * 1024
TASKS_PER_ITERATION = 5.125  # dma_w, dma_act, matmul, vec, dma_out, a join every 8
JOIN_EVERY, MARK_EVERY, NEIGHBOR_EVERY = 8, 64, 4

LABEL_SCHEMA = {
    "fields": [
        {"name": "kind", "shift": 56, "bits": 8, "enum": KINDS},
        {"name": "step", "shift": 48, "bits": 8},
        {"name": "layer", "shift": 40, "bits": 8},
        {"name": "unit", "shift": 32, "bits": 8},
        {"name": "idx", "shift": 0, "bits": 32},
    ],
    "format": "{kind} s{step} l{layer} u{unit} #{idx}",
}


def make_label(kind: str, step: int, layer: int, unit: int, idx: int) -> int:
    return ((KINDS.index(kind) << 56) | ((step & 0xFF) << 48) | ((layer & 0xFF) << 40)
            | ((unit & 0xFF) << 32) | (idx & 0xFFFFFFFF))


# A demand of a chunk: (resource, dir, amount).
Demand = tuple[int, int, int]


@dataclass(slots=True)
class Dep:
    consumer: "Task"
    producer: "Task | None"   # None: a Neutrino store wrote the range
    index: int
    owner: int                # Neutrino that owns the range
    versioned: bool
    state: int = -1
    resolved: int | None = None


@dataclass(slots=True)
class Task:
    key: int
    nu: int
    src_nu: int
    pe: int | None
    opcode: int
    version: int | None
    label: int | None
    dst_base: int
    dst_len: int
    chunks: list[list[Demand]] = field(default_factory=list)
    pipelined: bool = False   # DMA: chunks are requested back to back, not one after another
    latency: int = 0          # added to each chunk's end
    deps: list[Dep] = field(default_factory=list)
    child: "Program | None" = None
    call: int | None = None
    invoke: int | None = None
    ready: int | None = None
    issue: int | None = None
    complete: int | None = None
    retire: int | None = None
    queued: int | None = None
    sent: int | None = None
    pending: int = 0
    retire_on_complete: bool = False
    waiters: list[Callable[[int], None]] = field(default_factory=list)


@dataclass(slots=True)
class Program:
    nu: int
    name: str
    actions: list[tuple]
    spawn: Task | None
    ptr: int = 0
    start: int | None = None
    end: int | None = None
    invoked: list[Task] = field(default_factory=list)


@dataclass(slots=True)
class Pe:
    busy: bool = False
    queue: deque = field(default_factory=deque)


class Recorder:
    """Records of the dump in write order, as Python tuples."""

    def __init__(self) -> None:
        self.charges: list[tuple] = []   # start, amount, span, cycles, task key|-1, rid, dir, msg
        self.chunks: list[tuple] = []    # task key, index, start, end, culprit, queue_culprit
        self.marks: list[tuple] = []     # time, name id, nu|None
        # Neutrino table entries (trace-raw 4.7): start, end|None, base, len, task key|-1,
        # version|None, nu, peer|None, table, flags
        self.entries: list[tuple] = []
        # pending keys whose end is the producer's invoke: start, producer, base, version,
        # nu, peer|None, flags
        self.pending: list[tuple] = []
        # versions: (nu, base) -> [start, len, task key, last version]
        self.versions: dict[tuple[int, int], list] = {}
        self.strings: list[str] = []
        self._string_id: dict[str, int] = {}

    def string(self, s: str) -> int:
        """String id of `s`, assigned at first use."""
        sid = self._string_id.get(s)
        if sid is None:
            sid = self._string_id[s] = len(self.strings)
            self.strings.append(s)
        return sid


class Engine:
    """Event loop, resource calendars, message routes and the task life cycle."""

    def __init__(self, topo: Topology) -> None:
        self.topo = topo
        self.rates = [topo.rate(r["id"]) for r in topo.resources]
        # Per resource with a rate: the time each of its lanes is free.
        self.lane_free = [[0] * (r["lanes"] or 0) for r in topo.resources]
        self.lanes = [r["lanes"] or 0 for r in topo.resources]
        self.mem_port = [r["role"]["type"] == "mem_port" for r in topo.resources]
        self.beat = [r["beat_bytes"] or 64 for r in topo.resources]
        self.heap: list[tuple] = []
        self.seq = 0
        self.now = 0
        self.events = 0
        self.rec = Recorder()
        self.pes = [Pe() for _ in topo.pes]
        self.tasks: list[Task] = []
        self.programs: list[Program] = []
        self.last_writer: dict[tuple[int, int], Task] = {}
        self._routes: dict[tuple[int, int], list[tuple[int, int]]] = {}
        self.res = topo.res_id
        self.scalar = [self.res[f"{n['path']}.scalar"] for n in topo.nodes]
        self.complete_port = [self.res[f"{n['path']}.complete"] for n in topo.nodes]

    # -- event loop ---------------------------------------------------------------------

    def at(self, t: int, fn: Callable, *args) -> None:
        self.seq += 1
        heapq.heappush(self.heap, (t, self.seq, fn, args))

    def run(self) -> None:
        heap = self.heap
        while heap:
            t, _, fn, args = heapq.heappop(heap)
            self.now = t
            self.events += 1
            fn(t, *args)

    # -- resources ----------------------------------------------------------------------

    def lanes_free(self, rid: int, k: int) -> int:
        """The first time `k` lanes of a resource are free (the k-th earliest lane)."""
        return sorted(self.lane_free[rid])[k - 1]

    def hold(self, rid: int, k: int, end: int) -> None:
        """Holds the `k` earliest-free lanes of a resource until `end`."""
        free = self.lane_free[rid]
        for lane in sorted(range(len(free)), key=free.__getitem__)[:k]:
            free[lane] = end

    def reserve(self, earliest: int, demands: list[Demand], key: int, latency: int,
                msg: int | None = None) -> tuple[int, int, int | None, int | None]:
        """Grants one chunk: a common start and span on every rated resource.

        The span is set by the slowest resource (it holds all its lanes); every other
        rated resource holds ceil(its effective rate / its lane rate) lanes over the same
        span. A compute chunk (one with work) holds all lanes of its memory ports.
        Returns (start, end, culprit, queue_culprit) and records one charge per resource
        and direction.
        """
        per_res: dict[int, list[tuple[int, int]]] = {}
        for rid, d, amount in demands:
            per_res.setdefault(rid, []).append((d, amount))
        compute = any(d == raw.DIR_WORK for _, d, _ in demands)
        totals = {rid: sum(a for _, a in parts) for rid, parts in per_res.items()}
        longest, culprit = 0, None
        for rid, total in totals.items():
            rate = self.rates[rid]
            if rate is None:
                continue
            dur = max(1, math.ceil(total / rate))
            if dur > longest:
                longest, culprit = dur, rid
        held = {}
        for rid, total in totals.items():
            rate, lanes = self.rates[rid], self.lanes[rid]
            if rate is None:
                continue
            need = math.ceil(total * lanes / (longest * rate) - 1e-9)
            held[rid] = lanes if compute and self.mem_port[rid] else min(lanes, max(1, need))
        start, queue_culprit = earliest, None
        for rid, k in held.items():
            free = self.lanes_free(rid, k)
            if free > start:
                start, queue_culprit = free, rid
        for rid, k in held.items():
            self.hold(rid, k, start + longest)
        end = start + longest + latency
        charges = self.rec.charges
        msg_code = raw_null(8) if msg is None else msg
        for rid, parts in per_res.items():
            if self.rates[rid] is None:
                span = max(1, end - start)   # an unlimited link record is never 0 cycles
                for d, amount in parts:
                    charges.append((start, amount, span, span, key, rid, d, msg_code))
                continue
            lane_cycles = held[rid] * longest
            total = totals[rid]
            left = lane_cycles
            for i, (d, amount) in enumerate(parts):
                cyc = left if i == len(parts) - 1 else round(lane_cycles * amount / total)
                left -= cyc
                charges.append((start, amount, longest, cyc, key, rid, d, msg_code))
        return start, end, culprit, queue_culprit

    def scalar_work(self, nu: int, t: int, cycles: int) -> int:
        """Program work on the Neutrino's scalar resource (one lane); returns its end."""
        rid = self.scalar[nu]
        start = max(t, self.lanes_free(rid, 1))
        self.hold(rid, 1, start + cycles)
        self.rec.charges.append((start, cycles, cycles, cycles, -1, rid, raw.DIR_WORK,
                                 raw_null(8)))
        return start + cycles

    # -- messages -----------------------------------------------------------------------

    def route(self, src: int, dst: int) -> list[tuple[int, int]]:
        """Control links from Neutrino `src` to `dst`: (resource, latency after it)."""
        key = (src, dst)
        if key not in self._routes:
            self._routes[key] = self._control_route(src, dst)
        return self._routes[key]

    def _control_route(self, src: int, dst: int) -> list[tuple[int, int]]:
        nodes = self.topo.nodes
        hub = {0: "cbus", 1: "clcbus", 2: "smcbus"}

        def depth(n: int) -> int:
            return nodes[n]["path"].count(".")

        def hub_of(n: int) -> str:
            return f"{nodes[n]['path']}.{hub[depth(n)]}"

        def latency_of(n: int) -> int:
            return 20 if depth(n) == 1 else 10

        up_chain, down_chain = [src], [dst]
        a, b = src, dst
        while a != b:
            if depth(a) >= depth(b):
                a = nodes[a]["parent"]
                up_chain.append(a)
            else:
                b = nodes[b]["parent"]
                down_chain.append(b)
        names: list[tuple[str, int]] = [(f"{hub_of(src)}.neutrino.in", 0)]
        for child, parent in pairwise(up_chain):
            cname = nodes[child]["path"].rsplit(".", 1)[1]
            link = link_name(hub_of(child), hub_of(parent))
            names += [(f"{hub_of(child)}.{link}.out", 0),
                      (f"{nodes[child]['path']}.{link}.ab", latency_of(child)),
                      (f"{hub_of(parent)}.{cname}.{link}.in", 0)]
        down = list(reversed(down_chain))
        for parent, child in pairwise(down):
            cname = nodes[child]["path"].rsplit(".", 1)[1]
            link = link_name(hub_of(child), hub_of(parent))
            names += [(f"{hub_of(parent)}.{cname}.{link}.out", 0),
                      (f"{nodes[child]['path']}.{link}.ba", latency_of(child)),
                      (f"{hub_of(child)}.{link}.in", 0)]
        names.append((f"{hub_of(dst)}.neutrino.out", 0))
        return [(self.res[n], lat) for n, lat in names]

    def send(self, src: int, dst: int, kind: str, nbytes: int, t: int) -> tuple[int, int]:
        """Sends a protocol message; returns (departure on the first rated hop, arrival).

        Each rated hop transmits the message once it arrived and a lane is free: it holds
        one lane for one cycle per beat (ceil(bytes / beat_bytes), at least 1), whatever
        the link's lane count (as r2-sim does). An
        unlimited link takes the interval of the rated hop before it, or of the first
        rated hop if none is before it (trace-raw Section 4.4).
        """
        hops = self.route(src, dst)
        msg = MSG[kind]
        intervals: list[tuple[int, int] | None] = []
        first: tuple[int, int] | None = None
        prev: tuple[int, int] | None = None
        held: list[int] = []
        for rid, lat in hops:
            rate = self.rates[rid]
            if rate is None:
                intervals.append(prev)
                held.append(0)
                continue
            # As r2-sim: one lane, one cycle per beat, whatever the link's lane count.
            k = 1
            start = max(t, self.lanes_free(rid, k))
            dur = max(1, math.ceil(nbytes / self.beat[rid]))
            self.hold(rid, k, start + dur)
            prev = (start, start + dur)
            first = first or prev
            self.last_hop_start = start
            intervals.append(prev)
            held.append(k)
            t = start + dur + lat
        assert first is not None, "2p routes always have a rated hop"
        charges = self.rec.charges
        for (rid, _), iv, k in zip(hops, intervals, held, strict=True):
            s, e = iv or first
            span = e - s
            if self.rates[rid] is None:
                span = max(1, span)   # folded into a 0-cycle hop: [start, start + 1)
                charges.append((s, nbytes, span, span, -1, rid, raw.DIR_WRITE, msg))
            else:
                charges.append((s, nbytes, span, k * span, -1, rid, raw.DIR_WRITE, msg))
        self.first_hop_end = first[1]
        return first[0], t

    # -- task life cycle ----------------------------------------------------------------

    def new_task(self, **kw) -> Task:
        task = Task(key=len(self.tasks), **kw)
        self.tasks.append(task)
        return task

    def invoke(self, t: int, task: Task) -> None:
        """Entry into the scoreboard of `task.nu`."""
        task.invoke = t
        if task.version is not None:
            # The versions table: one entry per base; later invokes update its counter.
            entry = self.rec.versions.get((task.nu, task.dst_base))
            if entry is None:
                self.rec.versions[(task.nu, task.dst_base)] = [t, task.dst_len, task.key,
                                                               task.version]
            else:
                entry[3] = task.version
        if task.version is None:
            prev = self.last_writer.get((task.nu, task.dst_base))
            if prev is not None and prev.retire is None:
                if prev.complete is not None:
                    prev.retire = t
                else:
                    prev.retire_on_complete = True
            self.last_writer[(task.nu, task.dst_base)] = task
        task.pending = len(task.deps)
        for dep in task.deps:
            dep.state = producer_state(dep.producer)
            if dep.owner != task.nu:
                self.send_await(t, dep)
            elif dep.producer is None or dep.producer.complete is not None:
                self.at(t, self.resolve, dep)
            else:
                if dep.producer.invoke is None:
                    # A key named before its producer was invoked: pending (dependency).
                    p = dep.producer
                    self.rec.pending.append((t, p, p.dst_base, p.version if dep.versioned else None,
                                             task.nu, None, 0))
                dep.producer.waiters.append(
                    lambda tc, dep=dep: self.at(tc + C_RESOLVE, self.resolve, dep))
        if not task.deps:
            self.at(t, self.task_ready, task)

    def send_await(self, t: int, dep: Dep) -> None:
        """Remote dependency: Await to the owner, AwaitAck back, Resolve on completion.
        Entries: outbound_deps at the requester from the open (the consumer's invoke) to
        the AwaitAck (done) or Resolve arrival; inbound_refs at the owner for an Await that
        finds the key not done, until the completion; pending at the owner when the
        producer is not invoked yet."""
        consumer = dep.consumer.nu
        producer = dep.producer
        base = producer.dst_base if producer is not None else dep.consumer.dst_base
        version = producer.version if producer is not None and dep.versioned else None
        key = dep.consumer.key
        rec = self.rec
        _, arrival = self.send(consumer, dep.owner, "Await", MSG_BYTES, t)

        def at_owner(ta: int) -> None:
            if producer is not None and producer.invoke is None:
                rec.pending.append((ta, producer, base, version, dep.owner, consumer, 2))
            _, back = self.send(dep.owner, consumer, "AwaitAck", MSG_BYTES, ta)
            if producer is None or producer.complete is not None:
                rec.entries.append((t, back, base, 0, key, version, consumer, dep.owner,
                                    OUTBOUND_DEPS, 0))
                self.at(back + C_RESOLVE, self.resolve, dep)
                return

            def on_complete(tc: int) -> None:
                _, tr = self.send(dep.owner, consumer, "Resolve", MSG_BYTES, tc)
                rec.entries.append((ta, tc, base, 0, key, version, dep.owner, consumer,
                                    INBOUND_REFS, 0))
                rec.entries.append((t, tr, base, 0, key, version, consumer, dep.owner,
                                    OUTBOUND_DEPS, 1))
                self.at(tr + C_RESOLVE, self.resolve, dep)
            producer.waiters.append(on_complete)
        self.at(arrival, at_owner)

    def resolve(self, t: int, dep: Dep) -> None:
        dep.resolved = t
        task = dep.consumer
        task.pending -= 1
        if task.pending == 0:
            self.task_ready(t, task)

    def task_ready(self, t: int, task: Task) -> None:
        task.ready = t
        if task.pe is not None:
            self.pes[task.pe].queue.append(task)
            self.pe_try_start(t, task.pe)
        elif task.opcode == OP_SPAWN:
            task.issue = t
            child = task.child
            _, arrival = self.send(task.nu, child.nu, "Start", MSG_BYTES, t)
            self.at(arrival, self.program_start, child)
        else:
            task.issue = t
            self.exec_done(t, task)

    def pe_try_start(self, t: int, pid: int) -> None:
        pe = self.pes[pid]
        if pe.busy or not pe.queue:
            return
        task = pe.queue.popleft()
        pe.busy = True
        task.issue = t
        if task.pipelined:
            end = t
            earliest = t
            for i, demands in enumerate(task.chunks):
                start, cend, cul, qcul = self.reserve(earliest, demands, task.key,
                                                      task.latency)
                self.rec.chunks.append((task.key, i, start, cend, cul, qcul))
                earliest, end = start + 1, max(end, cend)
            self.at(end, self.exec_done, task)
        else:
            self.at(t, self.next_chunk, task, 0)

    def next_chunk(self, t: int, task: Task, i: int) -> None:
        if i == len(task.chunks):
            self.exec_done(t, task)
            return
        start, end, cul, qcul = self.reserve(t, task.chunks[i], task.key, task.latency)
        self.rec.chunks.append((task.key, i, start, end, cul, qcul))
        self.at(end, self.next_chunk, task, i + 1)

    def exec_done(self, t: int, task: Task) -> None:
        """Execution ended; the completion goes through the Neutrino's completion port."""
        rid = self.complete_port[task.nu]
        start = max(t, self.lanes_free(rid, 1))
        self.hold(rid, 1, start + C_COMPLETE)
        self.rec.charges.append((start, C_COMPLETE, C_COMPLETE, C_COMPLETE, task.key, rid,
                                 raw.DIR_WORK, raw_null(8)))
        self.at(start + C_COMPLETE, self.task_complete, task)

    def task_complete(self, t: int, task: Task) -> None:
        task.complete = t
        if task.version is not None or task.retire_on_complete:
            task.retire = t
        if task.pe is not None:
            self.pes[task.pe].busy = False
            self.pe_try_start(t, task.pe)
        waiters, task.waiters = task.waiters, []
        for w in waiters:
            w(t)

    # -- programs -----------------------------------------------------------------------

    def program_start(self, t: int, prog: Program) -> None:
        prog.start = t
        self.rec.string(prog.name)
        self.advance(t, prog)

    def advance(self, t: int, prog: Program) -> None:
        """Runs the program's actions from `prog.ptr` until one has to wait."""
        while prog.ptr < len(prog.actions):
            action = prog.actions[prog.ptr]
            op = action[0]
            if op == "invoke":
                task = action[1]
                if task.call is None:
                    task.call = t
                k = len(prog.invoked)
                if k >= WINDOW and prog.invoked[k - WINDOW].complete is None:
                    prog.invoked[k - WINDOW].waiters.append(
                        lambda tc, prog=prog: self.at(tc, self.advance, prog))
                    return
                prog.invoked.append(task)
                prog.ptr += 1
                end = self.scalar_work(prog.nu, t, C_INVOKE)
                if task.nu == prog.nu:
                    self.at(end, self.invoke, task)
                else:
                    task.queued = end
                    sent, arrival = self.send(prog.nu, task.nu, "Invoke", INVOKE_MSG_BYTES, end)
                    task.sent = sent
                    # outbound_invokes at the requester: c_invoke's end to the end of the
                    # first hop; inbound_invokes at the owner: the last hop to the invoke.
                    self.rec.entries.append((end, self.first_hop_end, task.dst_base,
                                             task.dst_len, task.key, None, prog.nu, task.nu,
                                             OUTBOUND_INVOKES, 0))
                    self.rec.entries.append((self.last_hop_start, arrival, task.dst_base,
                                             task.dst_len, task.key, task.version, task.nu,
                                             prog.nu, INBOUND_INVOKES, 0))
                    self.at(arrival, self.invoke, task)
                self.at(end, self.advance, prog)
                return
            if op == "store":
                _, demands = action
                prog.ptr += 1
                end = self.scalar_work(prog.nu, t, C_STORE)
                _, dend, _, _ = self.reserve(end, demands, -1, SMEM_LATENCY)
                self.at(dend, self.advance, prog)
                return
            if op == "wait":
                task = action[1]
                if task.complete is None:
                    task.waiters.append(lambda tc, prog=prog: self.at(tc, self.advance, prog))
                    return
                prog.ptr += 1
                t = max(t, task.complete + C_RESOLVE)
                continue
            if op == "mark":
                self.rec.marks.append((t, self.rec.string(action[1]), prog.nu))
                prog.ptr += 1
                continue
            if op == "send":
                _, dst, kind = action
                self.send(prog.nu, dst, kind, MSG_BYTES, t)
                prog.ptr += 1
                continue
            raise ValueError(f"unknown action {op}")
        self.program_return(t, prog)

    def program_return(self, t: int, prog: Program) -> None:
        prog.end = t
        for (nu, _), task in self.last_writer.items():
            if nu == prog.nu and task.retire is None and task.complete is not None:
                task.retire = t
        if prog.spawn is not None:
            parent = prog.spawn.nu
            _, arrival = self.send(prog.nu, parent, "Return", MSG_BYTES, t)
            self.at(arrival, self.exec_done, prog.spawn)


def raw_null(bits: int) -> int:
    return (1 << bits) - 1


def producer_state(producer: Task | None) -> int:
    """The producer's phase now: 0 not invoked, 1 scoreboard, 2 executing, 3 done."""
    if producer is None or producer.complete is not None:
        return 3
    if producer.invoke is None:
        return 0
    return 1 if producer.issue is None else 2


# ---------------------------------------------------------------------------------------
# The toy workload
# ---------------------------------------------------------------------------------------


class Workload:
    """Builds the programs and tasks of the toy workload (times are set by the engine)."""

    def __init__(self, eng: Engine, iterations: int, seed: int) -> None:
        self.eng = eng
        self.topo = eng.topo
        self.res = eng.res
        self.iterations = iterations
        self.rng = random.Random(seed)

    def nid(self, path: str) -> int:
        return self.topo.node_id[path]

    def demands(self, names: list[str], d: int, amount: int) -> list[Demand]:
        return [(self.res[n], d, amount) for n in names]

    def jitter(self, base: int, spread: float = 0.25, quantum: int = 512) -> int:
        v = base * self.rng.uniform(1 - spread, 1 + spread)
        return max(quantum, int(v) // quantum * quantum)

    def build(self) -> Program:
        eng = self.eng
        root = self.nid("root")
        gpc_programs: list[Program] = []
        sm_tasks: dict[tuple[int, int], dict] = {}
        sm_programs = {}
        for g in range(self.topo.gpcs):
            for s in range(self.topo.sms):
                sm_programs[(g, s)] = Program(self.nid(f"root.gpc{g}.sm{s}"), "sm_loop", [],
                                              None)
                sm_tasks[(g, s)] = {"vec": [], "out": []}
        # Tasks are created SM-major per iteration so that cross-SM references exist.
        for i in range(self.iterations):
            for g in range(self.topo.gpcs):
                for s in range(self.topo.sms):
                    self.iteration(g, s, i, sm_programs[(g, s)], sm_tasks)
        for g in range(self.topo.gpcs):
            for s in range(self.topo.sms):
                self.finish_sm(g, s, sm_programs[(g, s)], sm_tasks[(g, s)])
        for g in range(self.topo.gpcs):
            gpc = self.nid(f"root.gpc{g}")
            prog = Program(gpc, "gpc_stage", [], None)
            spawns = [self.spawn_task(gpc, sm_programs[(g, s)], s)
                      for s in range(self.topo.sms)]
            prog.actions += [("invoke", sp) for sp in spawns]
            join = self.join_task(gpc, [(sp, gpc) for sp in spawns],
                                  make_label("join", 0, 0, 8 + g, 0), 1)
            prog.actions += [("invoke", join), ("wait", join), ("mark", "gpc_done")]
            gpc_programs.append(prog)
        prog = Program(root, "forward", [("mark", "start")], None)
        spawns = [self.spawn_task(root, gp, g) for g, gp in enumerate(gpc_programs)]
        prog.actions += [("invoke", sp) for sp in spawns]
        join = self.join_task(root, [(sp, root) for sp in spawns],
                              make_label("none", 0, 0, 0, 0), 0)
        prog.actions += [("invoke", join), ("wait", join), ("mark", "end")]
        eng.programs = [prog, *gpc_programs, *sm_programs.values()]
        return prog

    def spawn_task(self, nu: int, child: Program, idx: int) -> Task:
        base = own_base(None, None, self.topo.sm_bits) if nu == 0 else self.base_of(nu)
        task = self.eng.new_task(nu=nu, src_nu=nu, pe=None, opcode=OP_SPAWN, version=None,
                                 label=None, dst_base=base + 0x1F0000000 + 0x1000 + idx * 512,
                                 dst_len=512, child=child)
        child.spawn = task
        return task

    def base_of(self, nu: int) -> int:
        path = self.topo.nodes[nu]["path"].split(".")
        g = int(path[1][3:]) if len(path) > 1 else None
        s = int(path[2][2:]) if len(path) > 2 else None
        return own_base(g, s, self.topo.sm_bits)

    def join_task(self, nu: int, producers: list[tuple[Task | None, int]], label: int,
                  slot: int) -> Task:
        base = self.base_of(nu)
        task = self.eng.new_task(nu=nu, src_nu=nu, pe=None, opcode=OP_JOIN, version=None,
                                 label=label, dst_base=base + 0x1F0000000 + slot * 512,
                                 dst_len=512)
        for k, (producer, owner) in enumerate(producers):
            versioned = producer is not None and producer.version is not None
            task.deps.append(Dep(task, producer, k, owner, versioned))
        return task

    def iteration(self, g: int, s: int, i: int, prog: Program, sm_tasks: dict) -> None:
        eng, rng = self.eng, self.rng
        G, S = f"root.gpc{g}", f"root.gpc{g}.sm{s}"
        nu, gnu = self.nid(S), self.nid(G)
        base, gbase = own_base(g, s, self.topo.sm_bits), own_base(g, None, self.topo.sm_bits)
        unit = g * self.topo.sms + s
        layer = i // MARK_EVERY
        buf = i % 2
        mine = sm_tasks[(g, s)]
        pe = {n: self.topo.pe_id[f"{S}.{n}"] for n in ("atlas", "muon", "dma")}
        lbus_w = [f"{S}.lbus.dma.in", f"{S}.lbus.smem.out", f"{S}.smem.port"]
        hbm_read = [f"{G}.hbm.port", f"{G}.clsbus.hbm.in",
                    f"{G}.clsbus.sm{s}.smsbus_to_clsbus.out", f"{S}.smsbus_to_clsbus.ba",
                    f"{S}.smsbus.smsbus_to_clsbus.in", f"{S}.smsbus.dma.out"]
        actions = prog.actions
        if i == 0:
            # The program stores a parameter block that the first activation DMA reads.
            actions.append(("store", self.demands([f"{S}.lbus.neutrino.in",
                                                   f"{S}.lbus.smem.out", f"{S}.smem.port"],
                                                  raw.DIR_WRITE, 4096)))

        w_bytes = self.jitter(128 * 1024)
        w_base = base + 0x10000 + buf * 0x20000
        dma_w = eng.new_task(nu=nu, src_nu=nu, pe=pe["dma"], opcode=OP_DMA,
                             version=i // 2 + 1, label=make_label("dma_w", 0, layer, unit, i),
                             dst_base=w_base, dst_len=w_bytes, pipelined=True,
                             latency=DMA_LATENCY + HBM_LATENCY)
        nchunks = math.ceil(w_bytes / CHUNK_BYTES)
        for c in range(nchunks):
            part = min(CHUNK_BYTES, w_bytes - c * CHUNK_BYTES)
            dma_w.chunks.append(self.demands(hbm_read, raw.DIR_READ, part)
                                + self.demands(lbus_w, raw.DIR_WRITE, part))

        a_bytes = self.jitter(32 * 1024)
        a_base = base + 0x60000 + buf * 0x10000
        neighbor = (s + self.topo.sms - 1) % self.topo.sms
        from_neighbor = i > 0 and i % NEIGHBOR_EVERY == 0
        if from_neighbor:
            N = f"{G}.sm{neighbor}"
            read = [f"{N}.smem.port", f"{N}.smsbus.smem.in", f"{N}.smsbus.smsbus_to_clsbus.out",
                    f"{N}.smsbus_to_clsbus.ab", f"{G}.clsbus.sm{neighbor}.smsbus_to_clsbus.in",
                    f"{G}.clsbus.sm{s}.smsbus_to_clsbus.out", f"{S}.smsbus_to_clsbus.ba",
                    f"{S}.smsbus.smsbus_to_clsbus.in", f"{S}.smsbus.dma.out"]
            latency = DMA_LATENCY + SMEM_LATENCY
        else:
            read, latency = hbm_read, DMA_LATENCY + HBM_LATENCY
        dma_a = eng.new_task(nu=nu, src_nu=nu, pe=pe["dma"], opcode=OP_DMA, version=None,
                             label=make_label("dma_act", 0, layer, unit, i), dst_base=a_base,
                             dst_len=a_bytes, pipelined=True, latency=latency)
        dma_a.chunks.append(self.demands(read, raw.DIR_READ, a_bytes)
                            + self.demands(lbus_w, raw.DIR_WRITE, a_bytes))
        if i == 0:
            dma_a.deps.append(Dep(dma_a, None, 0, nu, False))
        elif from_neighbor:
            # The neighbour's vector output of the previous iteration (remote, and maybe
            # not invoked yet when this DMA is invoked).
            producer = sm_tasks[(g, neighbor)]["vec"][i - 1]
            dma_a.deps.append(Dep(dma_a, producer, 0, producer.nu, False))

        macs = self.jitter(128 * 128 * 1024, quantum=16384)
        c_base = base + 0x80000 + buf * 0x10000
        matmul = eng.new_task(nu=nu, src_nu=nu, pe=pe["atlas"], opcode=OP_MATMUL, version=None,
                              label=make_label(MATMUL_KINDS[(i // 16) % len(MATMUL_KINDS)], 0,
                                               layer, unit, i),
                              dst_base=c_base, dst_len=64 * 1024, latency=SMEM_LATENCY)
        reads = [f"{S}.smem.port", f"{S}.lbus.smem.in", f"{S}.lbus.atlas.out"]
        writes = [f"{S}.lbus.atlas.in", f"{S}.lbus.smem.out", f"{S}.smem.port"]
        for _ in range(2):
            matmul.chunks.append(self.demands([f"{S}.atlas.array"], raw.DIR_WORK, macs // 2)
                                 + self.demands(reads, raw.DIR_READ, (w_bytes + a_bytes) // 2)
                                 + self.demands(writes, raw.DIR_WRITE, 32 * 1024))
        matmul.deps += [Dep(matmul, dma_w, 0, nu, True), Dep(matmul, dma_a, 1, nu, False)]

        o_base = base + 0xA0000 + buf * 0x10000
        vec = eng.new_task(nu=nu, src_nu=nu, pe=pe["muon"], opcode=OP_VECTOR, version=None,
                           label=make_label("vec", 0, layer, unit, i), dst_base=o_base,
                           dst_len=32 * 1024, latency=MUON_OVERHEAD)
        vreads = [f"{S}.smem.port", f"{S}.lbus.smem.in", f"{S}.lbus.muon.out"]
        vwrites = [f"{S}.lbus.muon.in", f"{S}.lbus.smem.out", f"{S}.smem.port"]
        vec.chunks.append(self.demands([f"{S}.muon.vector"], raw.DIR_WORK,
                                       self.jitter(65536, quantum=256))
                          + self.demands(vreads, raw.DIR_READ, 64 * 1024)
                          + self.demands(vwrites, raw.DIR_WRITE, 32 * 1024))
        vec.deps.append(Dep(vec, matmul, 0, nu, False))

        # DMA out: a task of the gpc on its copy engine, invoked from the SM (forwarded).
        out_bytes = self.jitter(16 * 1024)
        blk = s * 16 + i % 16
        dma_o = eng.new_task(nu=gnu, src_nu=nu, pe=self.topo.pe_id[f"{G}.dma"], opcode=OP_DMA,
                             version=i // 16 + 1,
                             label=make_label("dma_act", 1, layer, unit, i),
                             dst_base=gbase + 0x8000000 + blk * 0x10000, dst_len=out_bytes,
                             pipelined=True, latency=DMA_LATENCY + SMEM_LATENCY)
        dma_o.chunks.append(
            self.demands([f"{S}.smem.port", f"{S}.smsbus.smem.in",
                          f"{S}.smsbus.smsbus_to_clsbus.out", f"{S}.smsbus_to_clsbus.ab",
                          f"{G}.clsbus.sm{s}.smsbus_to_clsbus.in", f"{G}.clsbus.dma.out"],
                         raw.DIR_READ, out_bytes)
            + self.demands([f"{G}.clsbus.dma.in", f"{G}.clsbus.hbm.out", f"{G}.hbm.port"],
                           raw.DIR_WRITE, out_bytes))
        dma_o.deps.append(Dep(dma_o, vec, 0, nu, False))

        actions += [("invoke", dma_w), ("invoke", dma_a), ("invoke", matmul), ("invoke", vec),
                    ("invoke", dma_o)]
        mine["vec"].append(vec)
        mine["out"].append(dma_o)
        if i % JOIN_EVERY == JOIN_EVERY - 1:
            producers = [(vec, nu), (mine["vec"][-2], nu), (mine["out"][-2], gnu)]
            join = self.join_task(nu, producers, make_label("join", 0, layer, unit, i),
                                  rng.randrange(4))
            actions.append(("invoke", join))
        if i % MARK_EVERY == MARK_EVERY - 1:
            actions.append(("mark", f"block{layer}"))

    def finish_sm(self, g: int, s: int, prog: Program, mine: dict) -> None:
        """The final join of an SM program: its last outputs and their DMAs to HBM."""
        nu = prog.nu
        gnu = self.nid(f"root.gpc{g}")
        producers = [(t, gnu) for t in mine["out"][-4:]] + [(mine["vec"][-1], nu)]
        join = self.join_task(nu, producers, make_label("join", 1, 0, g * self.topo.sms + s, 0), 5)
        prog.actions += [("invoke", join), ("wait", join), ("send", gnu, "VersionReset")]


# ---------------------------------------------------------------------------------------
# Records and files
# ---------------------------------------------------------------------------------------

NULL16, NULL32, NULL64 = raw_null(16), raw_null(32), raw_null(64)
CREATED = "2026-10-01T00:00:00Z"   # fixed, so that a seed gives identical files


@dataclass
class Dump:
    """The record arrays of one dump, in write order, plus its JSON files."""

    manifest: dict
    summary: dict | None
    strings: list[str]
    records: dict[str, np.ndarray]
    truncate: dict[str, int] = field(default_factory=dict)  # bytes cut off a file's end

    def write(self, out: Path, compress: bool) -> None:
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        (out / "manifest.json").write_text(json.dumps(self.manifest, indent=1))
        (out / "strings.txt").write_text("".join(f"{s}\n" for s in self.strings))
        written = self.manifest["filters"]["records"] or list(raw.RECORD_FILES)
        for name in written:
            data = self.records[name]
            cut = self.truncate.get(name, 0)
            if cut:
                blob = data.tobytes()[:-cut]
                data = np.frombuffer(blob, dtype=np.uint8)
            raw.write_records(out, name, data, compress)
        if self.summary is not None:
            (out / "summary.json").write_text(json.dumps(self.summary, indent=1))


def nullable(values: list, null: int, dtype: str) -> np.ndarray:
    return np.array([null if v is None else v for v in values], dtype=dtype)


def collect(eng: Engine, params: dict, wall: float) -> tuple[Dump, dict]:
    """Turns the engine's state into record arrays; returns the dump and a stats JSON."""
    topo, rec = eng.topo, eng.rec
    tasks = eng.tasks
    order = sorted(range(len(tasks)), key=lambda k: (tasks[k].invoke, k))
    gid_of = np.empty(len(tasks) + 1, dtype=np.int64)
    gid_of[np.array(order, dtype=np.int64)] = np.arange(len(tasks))
    gid_of[-1] = NULL32   # key -1: no task
    end_time = eng.now

    t_rec = np.zeros(len(tasks), dtype=raw.record_dtype(raw.LAYOUTS["tasks"]))
    t_rec["gid"] = gid_of[: len(tasks)]
    for name in ("nu", "src_nu", "opcode", "dst_base", "dst_len"):
        t_rec[name] = [getattr(t, name) for t in tasks]
    t_rec["pe"] = nullable([t.pe for t in tasks], NULL16, "u2")
    t_rec["version"] = nullable([t.version for t in tasks], NULL32, "u4")
    t_rec["label"] = nullable([t.label for t in tasks], NULL64, "u8")
    for name in ("call", "invoke", "ready", "issue", "complete", "retire", "queued", "sent"):
        t_rec[name] = nullable([getattr(t, name) for t in tasks], NULL64, "u8")
    write_time = np.where(t_rec["retire"] == NULL64, end_time, t_rec["retire"])
    t_rec = t_rec[np.argsort(write_time, kind="stable")]

    c = np.array(rec.chunks, dtype=object).reshape(-1, 6)
    c_rec = np.zeros(len(c), dtype=raw.record_dtype(raw.LAYOUTS["chunks"]))
    c_rec["gid"] = gid_of[c[:, 0].astype(np.int64)]
    c_rec["index"] = c[:, 1].astype(np.int64)
    c_rec["start"] = c[:, 2].astype(np.int64)
    c_rec["end"] = c[:, 3].astype(np.int64)
    c_rec["culprit"] = nullable(list(c[:, 4]), NULL16, "u2")
    c_rec["queue_culprit"] = nullable(list(c[:, 5]), NULL16, "u2")

    deps = [d for t in tasks for d in t.deps]
    d_rec = np.zeros(len(deps), dtype=raw.record_dtype(raw.LAYOUTS["deps"]))
    d_rec["consumer"] = gid_of[[d.consumer.key for d in deps]]
    d_rec["producer"] = gid_of[[-1 if d.producer is None else d.producer.key for d in deps]]
    d_rec["resolved"] = nullable([d.resolved for d in deps], NULL64, "u8")
    d_rec["index"] = [d.index for d in deps]
    d_rec["state"] = [d.state for d in deps]
    d_rec["flags"] = [(d.owner != d.consumer.nu) | (d.versioned << 1) for d in deps]
    write_time = np.where(d_rec["resolved"] == NULL64, end_time, d_rec["resolved"])
    d_rec = d_rec[np.argsort(write_time, kind="stable")]

    ch = np.array(rec.charges, dtype=np.int64)
    g_rec = np.zeros(len(ch), dtype=raw.record_dtype(raw.LAYOUTS["charges"]))
    for i, name in enumerate(("start", "amount", "span", "cycles")):
        g_rec[name] = ch[:, i]
    g_rec["gid"] = gid_of[ch[:, 4]]
    g_rec["resource"] = ch[:, 5]
    g_rec["dir"] = ch[:, 6]
    g_rec["msg"] = ch[:, 7]
    g_rec = g_rec[np.argsort(g_rec["start"], kind="stable")]

    progs = [p for p in eng.programs if p.start is not None]
    p_rec = np.zeros(len(progs), dtype=raw.record_dtype(raw.LAYOUTS["programs"]))
    p_rec["nu"] = [p.nu for p in progs]
    p_rec["name"] = [rec.string(p.name) for p in progs]
    p_rec["spawn"] = [NULL32 if p.spawn is None else gid_of[p.spawn.key] for p in progs]
    p_rec["start"] = [p.start for p in progs]
    p_rec["end"] = nullable([p.end for p in progs], NULL64, "u8")
    write_time = np.where(p_rec["end"] == NULL64, end_time, p_rec["end"])
    p_rec = p_rec[np.argsort(write_time, kind="stable")]

    rec.marks.append((end_time, rec.string("run_end"), None))
    m_rec = np.zeros(len(rec.marks), dtype=raw.record_dtype(raw.LAYOUTS["marks"]))
    m_rec["time"] = [m[0] for m in rec.marks]
    m_rec["name"] = [m[1] for m in rec.marks]
    m_rec["nu"] = nullable([m[2] for m in rec.marks], NULL16, "u2")

    entries = list(rec.entries)
    for start, producer, base, version, nu, peer, flags in rec.pending:
        end = producer.invoke
        entries.append((start, end, base, 0, producer.key if end is not None else -1, version, nu,
                        peer, PENDING, flags))
    for (nu, base), (start, length, key, version) in rec.versions.items():
        entries.append((start, None, base, length, key, version, nu, None, VERSIONS, 0))
    e_rec = np.zeros(len(entries), dtype=raw.record_dtype(raw.LAYOUTS["entries"]))
    if entries:
        cols = list(zip(*entries, strict=True))
        e_rec["start"] = cols[0]
        e_rec["end"] = nullable(list(cols[1]), NULL64, "u8")
        e_rec["base"] = cols[2]
        e_rec["len"] = cols[3]
        e_rec["gid"] = gid_of[np.array(cols[4], dtype=np.int64)]
        e_rec["version"] = nullable(list(cols[5]), NULL32, "u4")
        e_rec["nu"] = cols[6]
        e_rec["peer"] = nullable(list(cols[7]), NULL16, "u2")
        e_rec["table"] = cols[8]
        e_rec["flags"] = cols[9]
    # Written when the entry leaves its table (open entries at the end of the run).
    write_time = np.where(e_rec["end"] == NULL64, end_time, e_rec["end"])
    e_rec = e_rec[np.argsort(write_time, kind="stable")]

    records = {"tasks": t_rec, "chunks": c_rec, "deps": d_rec, "charges": g_rec,
               "programs": p_rec, "marks": m_rec, "entries": e_rec}
    manifest = make_manifest(topo, params)
    summary = make_summary(end_time, eng.events, wall, records)
    busy = np.bincount(g_rec["resource"], weights=g_rec["cycles"], minlength=len(topo.resources))
    stats = {"end_time": end_time, "resources": [
        {"name": r["name"], "kind": r["kind"], "busy_cycles": int(busy[r["id"]])}
        for r in topo.resources if r["rate"] is not None]}
    return Dump(manifest, summary, list(rec.strings), records), stats


def make_manifest(topo: Topology, params: dict) -> dict:
    return {
        "format": "r2raw",
        "version": list(raw.RAW_VERSION),
        "run": {"config": "configs/2p.yaml", "program": "synthetic", "params": params,
                "overrides": [], "sim_commit": "synthetic", "clock_ghz": 1.0, "granule": 512,
                "created": CREATED},
        "filters": {"nodes": None, "records": None, "types": None, "window": None,
                    "partial": False},
        "records": raw.LAYOUTS,
        "nodes": topo.nodes, "pes": topo.pes, "buses": topo.buses,
        "attachments": topo.attachments, "links": topo.links, "memories": topo.memories,
        "resources": topo.resources,
        "opcodes": OPCODES,
        "message_kinds": raw.MESSAGE_KINDS,
        "label": LABEL_SCHEMA,
    }


def make_summary(end_time: int, events: int, wall: float, records: dict) -> dict:
    cut = [0, end_time // 10, end_time * 9 // 10, end_time]
    phases = [{"stage": "toy", "name": name, "layer": 0, "start": cut[i], "end": cut[i + 1],
               "estimate": (cut[i + 1] - cut[i]) * 9 // 10,
               "roofline": (cut[i + 1] - cut[i]) * 7 // 10, "bound_by": "smem"}
              for i, name in enumerate(("warmup", "steady", "drain"))]
    return {"end_time": end_time, "events": events, "wall_seconds": round(wall, 3),
            "counts": {name: int(len(a)) for name, a in records.items()},
            "fatal": None, "phases": phases}


def generate(tasks: int, seed: int, gpcs: int = 2, sms: int = 4) -> tuple[Dump, dict]:
    """Runs the toy workload sized to about `tasks` tasks."""
    t0 = time.perf_counter()
    eng = Engine(build(gpcs, sms))
    iterations = max(1, round(tasks / (gpcs * sms * TASKS_PER_ITERATION)))
    root = Workload(eng, iterations, seed).build()
    eng.at(0, eng.program_start, root)
    eng.run()
    params = {"generator": "r2t.synth", "tasks": tasks, "seed": seed, "iterations": iterations}
    return collect(eng, params, time.perf_counter() - t0)


# ---------------------------------------------------------------------------------------
# Variants: partial (trace-raw Section 1.1) and crashed (no summary, partial last record)
# ---------------------------------------------------------------------------------------


def subtree_nodes(topo_nodes: list[dict], paths: list[str]) -> np.ndarray:
    keep = [any(n["path"] == p or n["path"].startswith(p + ".") for p in paths)
            for n in topo_nodes]
    return np.array(keep, dtype=bool)


def overlaps(start: np.ndarray, end: np.ndarray, lo: int, hi: int) -> np.ndarray:
    return (start < hi) & (end > lo)


def partial(dump: Dump, paths: list[str], window: tuple[int, int],
            types: list[str]) -> Dump:
    """Applies the filters of trace-raw Section 1.1 to a full dump. `types` are the kept
    record types; `charges` and `messages` both go to charges.bin."""
    lo, hi = window
    m = dump.manifest
    end_time = dump.summary["end_time"]
    in_tree = subtree_nodes(m["nodes"], paths)
    res_owner = np.array([r["owner"] for r in m["resources"]])
    r = dump.records
    t = r["tasks"]
    retire = np.where(t["retire"] == NULL64, end_time, t["retire"])
    task_keep = in_tree[t["nu"]] & overlaps(t["invoke"], retire, lo, hi)
    kept_gids = np.zeros(int(t["gid"].max()) + 1, dtype=bool)
    kept_gids[t["gid"][task_keep]] = True
    nu_of_gid = np.zeros(len(kept_gids), dtype=np.int64)
    nu_of_gid[t["gid"]] = t["nu"]
    c = r["chunks"]
    chunk_keep = in_tree[nu_of_gid[c["gid"]]] & overlaps(c["start"], c["end"], lo, hi)
    d = r["deps"]
    dep_keep = kept_gids[d["consumer"]]
    g = r["charges"]
    is_message = g["msg"] != raw_null(8)
    type_ok = (is_message & ("messages" in types)) | (~is_message & ("charges" in types))
    charge_keep = type_ok & in_tree[res_owner[g["resource"]]] & overlaps(
        g["start"], g["start"] + g["span"], lo, hi)
    p = r["programs"]
    p_end = np.where(p["end"] == NULL64, end_time, p["end"])
    prog_keep = in_tree[p["nu"]] & overlaps(p["start"], p_end, lo, hi)
    mk = r["marks"]
    mark_nu_ok = np.where(mk["nu"] == NULL16, True, in_tree[np.minimum(mk["nu"], len(in_tree) - 1)])
    mark_keep = mark_nu_ok & (mk["time"] >= lo) & (mk["time"] < hi)
    e = r["entries"]
    e_end = np.where(e["end"] == NULL64, end_time, e["end"])
    entry_keep = in_tree[e["nu"]] & overlaps(e["start"], np.maximum(e_end, e["start"] + 1), lo, hi)
    kept = {"tasks": t[task_keep], "chunks": c[chunk_keep], "deps": d[dep_keep],
            "charges": g[charge_keep], "programs": p[prog_keep], "marks": mk[mark_keep],
            "entries": e[entry_keep]}
    records = [name for name in raw.RECORD_FILES
               if name in types or (name == "charges" and "messages" in types)]
    kept = {name: a for name, a in kept.items() if name in records}
    manifest = dict(m, filters={"nodes": paths, "records": records, "types": types,
                                "window": [lo, hi], "partial": True})
    summary = dict(dump.summary, counts={name: int(len(a)) for name, a in kept.items()})
    return Dump(manifest, summary, dump.strings, kept)


def crashed(dump: Dump, fraction: float) -> Dump:
    """The dump of a process killed at `fraction` of the run: records written before the
    cut, a partial last record in two files, and no summary.json."""
    cut = int(dump.summary["end_time"] * fraction)
    r = dump.records
    t, d, p = r["tasks"], r["deps"], r["programs"]
    kept = {
        "tasks": t[(t["retire"] != NULL64) & (t["retire"] < cut)],
        "chunks": r["chunks"][r["chunks"]["start"] < cut],
        "deps": d[(d["resolved"] != NULL64) & (d["resolved"] < cut)],
        "charges": r["charges"][r["charges"]["start"] < cut],
        "programs": p[(p["end"] != NULL64) & (p["end"] < cut)],
        "marks": r["marks"][r["marks"]["time"] < cut],
        "entries": r["entries"][(r["entries"]["end"] != NULL64) & (r["entries"]["end"] < cut)],
    }
    truncate = {"tasks": 50, "charges": 13}
    return Dump(dump.manifest, None, dump.strings, kept, truncate)


# ---------------------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------------------


def write_suite(out: Path) -> None:
    """The test traces of the r2-vis assignment T1."""
    out.mkdir(parents=True, exist_ok=True)
    for name, tasks, seed in (("tiny", 200, 1), ("medium", 500_000, 3)):
        dump, stats = timed(name, lambda n=tasks, s=seed: generate(n, s))
        dump.write(out / name, compress=False)
        (out / f"{name}.stats.json").write_text(json.dumps(stats, indent=1))
    small, stats = timed("small", lambda: generate(20_000, 2))
    small.write(out / "small", compress=False)
    (out / "small.stats.json").write_text(json.dumps(stats, indent=1))
    small.write(out / "small-zstd", compress=True)
    end = small.summary["end_time"]
    partial(small, ["root.gpc0.sm1"], (end // 3, 2 * end // 3),
            ["tasks", "chunks", "deps", "charges", "messages", "programs", "entries"]).write(
                out / "partial", False)
    crashed(small, 0.6).write(out / "crashed", compress=False)


def timed(name: str, fn: Callable):
    t0 = time.perf_counter()
    result = fn()
    dump = result[0]
    counts = {k: len(v) for k, v in dump.records.items()}
    print(f"{name}: {time.perf_counter() - t0:.1f} s, end {dump.summary['end_time']}, {counts}")
    return result


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("out", type=Path, help="output directory (a raw dump, or the suite root)")
    ap.add_argument("--tasks", type=int, default=20_000, help="approximate task count")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--zstd", action="store_true", help="compress the binary files")
    ap.add_argument("--stats", type=Path, help="also write a --stats-like JSON here")
    ap.add_argument("--gpcs", type=int, default=2, help="gpcs (a 2p-like variant if not 2)")
    ap.add_argument("--sms", type=int, default=4, help="SMs per gpc")
    ap.add_argument("--suite", action="store_true",
                    help="write tiny, small, medium, partial, crashed, small-zstd into OUT")
    args = ap.parse_args(argv)
    if args.suite:
        write_suite(args.out)
        return
    dump, stats = timed(args.out.name, lambda: generate(args.tasks, args.seed, args.gpcs, args.sms))
    dump.write(args.out, args.zstd)
    if args.stats:
        args.stats.write_text(json.dumps(stats, indent=1))


if __name__ == "__main__":
    main()
