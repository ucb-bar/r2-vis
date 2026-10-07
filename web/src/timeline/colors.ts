// Task colors: one categorical slot per label kind, opcode as the fallback. The slots are
// chosen so that the kinds that share a lane pass the palette validator (dataviz,
// --pairs all): DMA lanes blue/aqua, Atlas lanes yellow/magenta/green/violet, Muon orange.
// Kinds without a slot (router, join, none, unknown) are "other" (neutral).
import { isDict, type DictColumn } from '../data/columns'
import type { Trace } from '../data/trace'

export const OTHER = 8

const KIND_SLOT: Record<string, number> = {
  dma_w: 0, vec: 1, dma_act: 2, qkv: 3, attn: 4, wo: 5, ffn_gate: 6, ffn_up: 6, ffn_down: 6,
}
const OPCODE_SLOT: Record<string, number> = { dma: 0, 'muon.vector': 1, 'atlas.matmul': 3 }

export interface LegendEntry {
  slot: number
  names: string[]
}

/** Slot per task (0..7, or OTHER), and the legend of the slots in use. */
export function taskSlots(trace: Trace): { slots: Uint8Array; legend: LegendEntry[] } {
  const tasks = trace.facts.tasks
  const kind = tasks.cols.kind as DictColumn | undefined
  const opcode = tasks.cols.opcode as Int32Array
  const opNames = trace.dims.opcodes.map((o) => String(o.name))
  const slots = new Uint8Array(tasks.rows)
  const kindSlot = kind && isDict(kind) ? kind.dict.map((k) => KIND_SLOT[k] ?? OTHER) : []
  const opSlot = opNames.map((o) => OPCODE_SLOT[o] ?? OTHER)
  const used = new Map<number, Set<string>>()
  for (let i = 0; i < tasks.rows; i++) {
    const k = kind ? kind.codes[i] : -1
    const slot = k >= 0 ? kindSlot[k] : opSlot[opcode[i]] ?? OTHER
    slots[i] = slot
  }
  // Legend: names per slot, from the kinds and opcodes present.
  const seenKind = new Set<number>()
  const seenOp = new Set<number>()
  for (let i = 0; i < tasks.rows; i++) {
    const k = kind ? kind.codes[i] : -1
    if (k >= 0) seenKind.add(k)
    else seenOp.add(opcode[i])
  }
  const add = (slot: number, name: string) => {
    if (!used.has(slot)) used.set(slot, new Set())
    used.get(slot)?.add(name)
  }
  for (const k of seenKind) add(kindSlot[k], (kind as DictColumn).dict[k])
  for (const o of seenOp) add(opSlot[o] ?? OTHER, `${opNames[o]} (no label)`)
  const legend = [...used.entries()].sort((a, b) => a[0] - b[0])
    .map(([slot, names]) => ({ slot, names: [...names] }))
  return { slots, legend }
}

/** Line color token of every resource (`--line-<slot>`): fabric in cool families, one
 * step per bus or link level (global blue, local teal, control indigo); memory ports in
 * the family of their bus side; tensor and vector arrays in warm hues; Neutrino scalar and
 * completion ports a warm grey. */
export function lineSlots(trace: Trace): string[] {
  const nodes = trace.dims.nodes
  const depthOf = (node: number) => String(nodes[node].path).split('.').length - 1
  const buses = trace.dims.buses
  const atts = trace.dims.attachments
  const links = trace.dims.links
  const mems = trace.dims.memories
  const step = (d: number) => Math.max(0, Math.min(4, d))
  return trace.dims.resources.map((r) => {
    const role = String(r.role)
    const cls = String(r.class ?? '')
    if (role === 'pe') return r.kind === 'TensorOps' ? 'tensor' : 'vector'
    if (role === 'scalar' || role === 'complete') return 'scalar'
    if (role === 'mem_port') {
      const mem = mems[r.memory as number]
      if (mem?.type === 'dram') {
        const att = atts.find((a) => a.component === mem.path)
        const busNode = att ? (buses[att.bus as number].node as number) : (mem.node as number)
        return `global-${step(2 * depthOf(busNode))}`
      }
      return 'local-1'
    }
    const family = cls === 'control' ? 'control' : cls === 'local' ? 'local' : 'global'
    if (role === 'link') {
      // Between the levels of its two buses (the deeper end sets the step).
      const l = links[r.link as number]
      const deeper = Math.max(depthOf(buses[l.from_bus as number].node as number),
        depthOf(buses[l.to_bus as number].node as number))
      return family === 'local' ? 'local-0' : `${family}-${step(2 * deeper - 1)}`
    }
    const bus = r.bus as number | null
    if (bus === null) return `${family}-0`
    return family === 'local' ? 'local-0' : `${family}-${step(2 * depthOf(buses[bus].node as number))}`
  })
}
