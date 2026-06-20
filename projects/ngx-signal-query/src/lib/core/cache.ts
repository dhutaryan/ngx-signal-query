import { signal } from '@angular/core'

export abstract class Cache<TEntry> {
  readonly #entries = signal<TEntry[]>([])

  // Reactive snapshot of all entries; updated on add/remove/clear so that
  // findAll() (and its computed consumers like isFetching) react to the
  // collection. Protected: only subclasses read it, never external code.
  protected readonly entries = this.#entries.asReadonly()

  readonly #entriesMap = new Map<string, TEntry>()

  getAll(): TEntry[] {
    return Array.from(this.#entriesMap.values())
  }

  clear(): void {
    this.#entriesMap.clear()
    this.#sync()
  }

  protected addEntry(key: string, entry: TEntry): TEntry {
    this.#entriesMap.set(key, entry)
    this.#sync()

    return entry
  }

  protected getEntry(key: string): TEntry | undefined {
    return this.#entriesMap.get(key)
  }

  protected removeEntry(key: string): boolean {
    const removed = this.#entriesMap.delete(key)

    if (removed) this.#sync()

    return removed
  }

  #sync(): void {
    this.#entries.set(Array.from(this.#entriesMap.values()))
  }
}
