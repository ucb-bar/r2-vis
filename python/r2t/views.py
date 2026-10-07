"""views.sql of the processed trace (trace-format.md Section 7)."""

from __future__ import annotations

import re

TABLES = ["nodes", "pes", "lanes", "buses", "attachments", "links", "memories",
          "memory_ranges", "resources", "opcodes", "message_kinds", "dirs", "dep_states",
          "tasks", "chunks", "deps", "programs", "charges", "bins", "marks", "phases"]

HEADER = """\
-- r2t views. Open the trace with `r2t-sql RUN.r2t [QUERY]`, or run DuckDB from inside the
-- trace directory: cd RUN.r2t && duckdb -init views.sql
-- The Parquet paths are relative to the trace directory.
"""

NAME_VIEWS = """
-- Tasks with names and the three time parts of a task.
CREATE OR REPLACE VIEW v_tasks AS
SELECT t.*, l.path AS lane_path, o.name AS opcode_name, {label_name} AS label_name,
       t.ready - t.invoke AS wait, t.issue - t.ready AS queue, t.complete - t.issue AS exec
FROM tasks t
LEFT JOIN lanes l ON l.id = t.lane
LEFT JOIN opcodes o ON o.id = t.opcode;

-- Chunks with their task kind and lane, and the culprit names.
CREATE OR REPLACE VIEW v_chunks AS
SELECT c.*, c."end" - c.start AS cycles, t.kind, t.lane,
       r.name AS culprit_name, q.name AS queue_culprit_name
FROM chunks c
LEFT JOIN tasks t ON t.gid = c.gid
LEFT JOIN resources r ON r.id = c.culprit
LEFT JOIN resources q ON q.id = c.queue_culprit;

-- Dependencies with the state name; producer_in_trace is false when the producer has no
-- task row (a partial trace).
CREATE OR REPLACE VIEW v_deps AS
SELECT d.*, s.name AS state_name,
       d.producer IS NOT NULL AND p.gid IS NOT NULL AS producer_in_trace
FROM deps d
LEFT JOIN dep_states s ON s.id = d.state
LEFT JOIN tasks p ON p.gid = d.producer;

-- Bins with their start cycle t and the resource name and class.
CREATE OR REPLACE VIEW v_bins AS
SELECT b.*, b.bin::BIGINT * {bin_width} AS t, r.name AS resource_name, r.class,
       dn.name AS dir_name
FROM bins b
LEFT JOIN resources r ON r.id = b.resource
LEFT JOIN dirs dn ON dn.id = b.dir;

-- Charges with the resource name and class, the direction and the message name, and the
-- link lanes the row holds (cycles / span; NULL for a zero-cycle charge).
CREATE OR REPLACE VIEW v_charges AS
SELECT c.*, r.name AS resource_name, r.class, r.kind, r.unit, dn.name AS dir_name,
       mk.name AS msg_name,
       CASE WHEN c."end" > c.start THEN c.cycles::DOUBLE / (c."end" - c.start) END AS lanes_held
FROM charges c
LEFT JOIN resources r ON r.id = c.resource
LEFT JOIN dirs dn ON dn.id = c.dir
LEFT JOIN message_kinds mk ON mk.id = c.msg;
"""

MACROS = """
-- The end of the run in cycles.
CREATE OR REPLACE MACRO end_time() AS {end_time};

-- Per resource over [a, b): busy lane-cycles and amount of the charges clipped to the
-- range (a charge counts in proportion to its overlap; a zero-cycle charge counts if its
-- start is in the range), the busy fraction busy / (lanes * (b - a)) (NULL if unlimited)
-- and the utilization amount / (ceiling * (b - a)).
CREATE OR REPLACE MACRO util(a, b) AS TABLE
WITH c AS (
    SELECT resource, cycles, amount,
           CASE WHEN "end" > start
                THEN (least("end", b) - greatest(start, a))::DOUBLE / ("end" - start)
                ELSE 1.0 END AS f
    FROM charges
    WHERE start < b AND ("end" > a OR ("end" = start AND start >= a))
), s AS (
    SELECT resource, sum(cycles * f) AS busy, sum(amount * f) AS amount
    FROM c GROUP BY resource
)
SELECT r.id, r.name, r.node, r.kind, r.unit, r.class, r.is_link, r.rate, r.lanes, r.ceiling,
       coalesce(s.busy, 0) AS busy, coalesce(s.amount, 0) AS amount,
       coalesce(s.busy, 0) / (r.lanes * (b - a)) AS busy_frac,
       coalesce(s.amount, 0) / (r.ceiling * (b - a)) AS util
FROM resources r LEFT JOIN s ON s.resource = r.id
ORDER BY r.id;

-- Culprit cycles over [a, b): the chunk time inside the range charged to the chunk's
-- service culprit. level 'resource': one row per culprit resource; level 'subtree': one
-- row per node, summed over the resources owned by the node and its descendants.
-- queued_chunks counts the chunks that the resource delayed (queue_culprit).
CREATE OR REPLACE MACRO culprits(a, b) AS TABLE
WITH w AS (
    SELECT culprit, queue_culprit, least("end", b) - greatest(start, a) AS cycles
    FROM chunks WHERE start < b AND "end" > a
), c AS (
    SELECT culprit AS resource, sum(cycles) AS cycles, count(*) AS chunks
    FROM w WHERE culprit IS NOT NULL GROUP BY culprit
), q AS (
    SELECT queue_culprit AS resource, count(*) AS queued_chunks
    FROM w WHERE queue_culprit IS NOT NULL GROUP BY queue_culprit
), per_res AS (
    SELECT r.id AS resource, r.name, r.node, coalesce(c.cycles, 0) AS cycles,
           coalesce(c.chunks, 0) AS chunks, coalesce(q.queued_chunks, 0) AS queued_chunks
    FROM resources r
    LEFT JOIN c ON c.resource = r.id
    LEFT JOIN q ON q.resource = r.id
    WHERE c.resource IS NOT NULL OR q.resource IS NOT NULL
), total AS (SELECT sum(cycles) AS cycles FROM per_res)
SELECT 'resource' AS level, p.resource AS id, p.name, p.node, p.cycles,
       p.cycles / nullif(total.cycles, 0) AS share, p.chunks, p.queued_chunks
FROM per_res p, total
UNION ALL
SELECT 'subtree' AS level, n.id, n.path AS name, n.id AS node, sum(p.cycles) AS cycles,
       sum(p.cycles) / nullif(any_value(total.cycles), 0) AS share, sum(p.chunks),
       sum(p.queued_chunks)
FROM nodes n
JOIN nodes rn ON rn.path = n.path OR starts_with(rn.path, n.path || '.')
JOIN per_res p ON p.node = rn.id
CROSS JOIN total
GROUP BY n.id, n.path
ORDER BY level, cycles DESC;

-- Tasks that execute in [a, b): issue < b and complete > a (a task that did not complete
-- counts until the end of the run).
CREATE OR REPLACE MACRO active_tasks(a, b) AS TABLE
SELECT * FROM v_tasks
WHERE issue IS NOT NULL AND issue < b AND coalesce(complete, end_time()) > a
ORDER BY issue;
"""


def label_name_sql(label: dict) -> str:
    """SQL that formats a label like manifest.label.format, e.g. 'qkv s0 l1 u2 #7'."""
    fmt = label.get("format")
    names = {f["name"] for f in label.get("fields", [])}
    if not fmt:
        return "NULL"
    parts = []
    for i, piece in enumerate(re.split(r"\{(\w+)\}", fmt)):
        if i % 2:
            if piece not in names:
                raise ValueError(f"label format names unknown field {piece}")
            parts.append(f"t.{piece}::VARCHAR")
        elif piece:
            parts.append("'" + piece.replace("'", "''") + "'")
    return "CASE WHEN t.label IS NULL THEN NULL ELSE " + " || ".join(parts) + " END"


def views_sql(label: dict, end_time: int, bin_width: int) -> str:
    lines = [HEADER]
    for name in TABLES:
        lines.append(f"CREATE OR REPLACE VIEW {name} AS SELECT * FROM "
                     f"read_parquet('{name}.parquet');")
    lines.append(NAME_VIEWS.format(label_name=label_name_sql(label), bin_width=bin_width))
    lines.append(MACROS.format(end_time=end_time))
    return "\n".join(lines)
