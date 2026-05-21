export abstract class Cache<TEntry> {
  readonly #entries = new Map<string, TEntry>()

  protected addEntry(key: string, entry: TEntry): TEntry {
    this.#entries.set(key, entry)
    return entry
  }

  protected getEntry(key: string): TEntry | undefined {
    return this.#entries.get(key)
  }

  protected hasEntry(key: string): boolean {
    return this.#entries.has(key)
  }

  protected removeEntry(key: string): boolean {
    return this.#entries.delete(key)
  }

  getAll(): TEntry[] {
    return Array.from(this.#entries.values())
  }

  clear(): void {
    this.#entries.clear()
  }
}
