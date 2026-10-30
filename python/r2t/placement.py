"""Where a task is in its program's source map (r2-toolchain docs/source-map.md, version 2):
its item, from the task's pc and call path (raw 1.11 `call_path`).

The first element of a call path is a `call_pcs` entry of a `call` item of the program
function, the next one of a `call` item of the helper or closure that the first one calls,
and so on; the pc is then in the `static_pcs` of an item of the last function. A call into a
function outside the crate is an invoke or wait item with `call_pcs`: the path ends there.
A tail call pushes no frame, so the tasks of the function it jumps to carry the caller's
path. A task without a call path whose pc is in a `static_pcs_by_call` entry is at that call
line (a closure inlined there). A version 1 map has no call items: tasks place by pc only.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Placement:
    """The item of a task (its id: the path of child indices) and the call statements that
    led to it, outermost first, as source lines (`calls`). `miss` is why the call path did not
    place it: "path" (an element names no call of the map) or "pc" (no item of the function
    that the path reaches holds the pc); the item then comes from the pc alone."""

    item: str | None
    calls: tuple[int, ...] = ()
    miss: str | None = None


@dataclass
class Scope:
    """A function of the map program (the program function, a helper or an out-of-line
    closure): the items in it by id, its call items, and its pcs."""

    root: str
    items: dict[str, dict] = field(default_factory=dict)
    calls: list[tuple[str, dict]] = field(default_factory=list)
    by_pc: dict[int, str] = field(default_factory=dict)
    by_call_pc: dict[int, tuple[str, dict]] = field(default_factory=dict)


def pcs(values: list | None) -> list[int]:
    """Hex strings (or numbers) as integers."""
    return [int(v, 16) if isinstance(v, str) else int(v) for v in values or []]


class ProgramMap:
    """The functions of one program of a source map, and placement by call path."""

    def __init__(self, program: dict):
        self.helpers: dict[str, str] = {}
        self.closures: dict[tuple[int, int], str] = {}
        self.items: dict[str, dict] = {}
        for i, item in enumerate(program.get("items", [])):
            self._index(item, str(i))
            if i > 0 and item["kind"] == "function":
                self.helpers[item.get("name", "")] = str(i)
        self.scopes = {root: self._scope(root) for root in
                       ["0", *self.helpers.values(), *self.closures.values()] if root in self.items}

    def _index(self, item: dict, at: str) -> None:
        self.items[at] = item
        if item["kind"] == "closure":
            self.closures[tuple(item["lines"])] = at
        for k, child in enumerate(item.get("children", [])):
            self._index(child, f"{at}.{k}")

    def _scope(self, root: str) -> Scope:
        """The items of a function: its subtree. An inlined closure's copies belong to the
        function around them, so a closure inside is part of it too; the out-of-line copy of
        a closure is its own scope (reached through a call item)."""
        s = Scope(root)
        for at, item in self.items.items():
            if at != root and not at.startswith(f"{root}."):
                continue
            s.items[at] = item
            for pc in pcs(item.get("static_pcs")):
                s.by_pc.setdefault(pc, at)
            if item["kind"] in ("call", "invoke", "wait"):
                for pc in pcs(item.get("call_pcs")):
                    s.by_call_pc.setdefault(pc, (at, item))
        return s

    def _callee(self, call: dict) -> str | None:
        """The scope that a call item calls: a helper by name, or a closure by its lines."""
        if "function" in call:
            return self.helpers.get(call["function"])
        if "closure" in call:
            return self.closures.get(tuple(call["closure"]))
        return None

    def place(self, path: list[int] | None, pc: int) -> Placement:
        """The item of a task with this call path (outermost call first; None or empty for a
        task of the program function) and pc."""
        scope = self.scopes.get("0")
        if scope is None:
            return Placement(None, (), "path")
        calls: list[int] = []
        for element in path or []:
            hit = scope.by_call_pc.get(element)
            if hit is None:
                return Placement(self.by_pc_only(pc), (), "path")
            at, item = hit
            calls.append(item["lines"][0])
            if item["kind"] in ("invoke", "wait"):
                return Placement(at, tuple(calls))   # a call out of the crate: the path ends
            nxt = self._callee(item)
            if nxt is None or nxt not in self.scopes:
                return Placement(self.by_pc_only(pc), (), "path")
            scope = self.scopes[nxt]
        at = self._in_scope(scope, pc, set())
        if at is None:
            return Placement(self.by_pc_only(pc), (), "pc")
        if not path:
            line = self.inlined_call(at, pc)
            if line is not None:
                calls.append(line)
        return Placement(at, tuple(calls))

    def _in_scope(self, scope: Scope, pc: int, seen: set[str]) -> str | None:
        """The item of a pc in a scope, or in a function it tail-calls (no frame of its own)."""
        if pc in scope.by_pc:
            return scope.by_pc[pc]
        seen.add(scope.root)
        for item in scope.items.values():
            if item["kind"] != "call" or not item.get("tail"):
                continue
            nxt = self._callee(item)
            if nxt in self.scopes and nxt not in seen:
                at = self._in_scope(self.scopes[nxt], pc, seen)
                if at is not None:
                    return at
        return None

    def inlined_call(self, at: str, pc: int) -> int | None:
        """The call line of an inlined closure copy that holds the pc, if the item has one."""
        for entry in self.items[at].get("static_pcs_by_call") or []:
            if pc in pcs(entry.get("pcs")):
                return int(entry["line"])
        return None

    def by_pc_only(self, pc: int) -> str | None:
        """The first item (in id order) whose static_pcs hold the pc, in any function."""
        for scope in self.scopes.values():
            if pc in scope.by_pc:
                return scope.by_pc[pc]
        return None
