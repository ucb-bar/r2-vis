// The block selection: which nodes the timeline shows. One store for the whole GUI (the
// Blocks panel now, the block diagram view later).
import { Store } from './store'

export class BlockSelection extends Store<ReadonlySet<number>> {
  constructor(nodeIds: number[]) {
    super(new Set(nodeIds))
  }

  has(node: number): boolean {
    return this.get().has(node)
  }

  setChecked(node: number, checked: boolean): void {
    const next = new Set(this.get())
    if (checked) next.add(node)
    else next.delete(node)
    this.set(next)
  }

  setAll(nodes: number[], checked: boolean): void {
    const next = new Set(this.get())
    for (const n of nodes) {
      if (checked) next.add(n)
      else next.delete(n)
    }
    this.set(next)
  }
}
