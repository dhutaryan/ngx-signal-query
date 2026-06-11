import { Injectable } from '@angular/core'

import { Cache } from './cache'
import { hashKey, partialMatchKey } from './utils'
import { Query } from './query'
import { QueryFilters, QueryKey } from './types'

@Injectable()
export class QueryCache extends Cache<Query<unknown, unknown>> {
  getOrCreate<TData, TError = Error>(key: QueryKey): Query<TData, TError> {
    const queryHash = hashKey(key)
    const exist = this.getEntry(queryHash)

    if (exist) return exist as Query<TData, TError>

    return this.addEntry(queryHash, new Query(key, queryHash, this)) as Query<
      TData,
      TError
    >
  }

  get<TData, TError = Error>(key: QueryKey): Query<TData, TError> | undefined {
    return this.getEntry(hashKey(key)) as Query<TData, TError> | undefined
  }

  findAll(filters: QueryFilters = {}): Query<unknown, unknown>[] {
    const { queryKey, exact } = filters

    // Reads the reactive `entries()` so findAll() works inside computed().
    const all = this.entries()

    if (!queryKey) return all

    if (exact) {
      const queryHash = hashKey(queryKey)
      return all.filter((query) => query.queryHash === queryHash)
    }

    return all.filter((query) => partialMatchKey(query.key, queryKey))
  }

  remove(query: Query<unknown, unknown>): void {
    this.removeEntry(query.queryHash)
  }

  override clear(): void {
    this.getAll().forEach((query) => query.destroy())
    super.clear()
  }
}
