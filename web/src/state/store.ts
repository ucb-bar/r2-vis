// A minimal observable value.

export class Store<T> {
  private value: T
  private readonly listeners = new Set<(v: T) => void>()

  constructor(initial: T) {
    this.value = initial
  }

  get(): T {
    return this.value
  }

  set(v: T): void {
    this.value = v
    for (const l of this.listeners) l(v)
  }

  subscribe(l: (v: T) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
}
