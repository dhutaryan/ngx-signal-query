import {
  DestroyRef,
  Injectable,
  NgZone,
  PendingTasks,
  inject,
} from '@angular/core'

import { Cache } from './cache'
import { hashKey, partialMatchKey } from './utils'
import { Query } from './query'
import type { QueryFilters, QueryKey } from './types'

/** @internal */
@Injectable()
export class QueryCache extends Cache<Query<unknown, unknown>> {
  // The app's pending tasks and Angular's zone, handed to each query it
  // creates, which has no injector of its own.
  readonly #pendingTasks = inject(PendingTasks)
  readonly #zone = inject(NgZone)

  constructor() {
    super()

    // The cache goes with the injector that provides it. Its queries stop
    // with it: once nothing can reach them, no fetch of theirs may keep the
    // app busy, and no timer of theirs may run on.
    inject(DestroyRef).onDestroy(() => this.clear())
  }

  // The hash is the key's, unless the caller brings the one the query had
  // elsewhere, as a query the server hands over does.
  getOrCreate<TData, TError = Error>(
    key: QueryKey,
    gcTime: number,
    queryHash = hashKey(key),
  ): Query<TData, TError> {
    const exist = this.getEntry(queryHash)

    if (exist) return exist as Query<TData, TError>

    return this.addEntry(
      queryHash,
      new Query({
        key,
        queryHash,
        cache: this,
        gcTime,
        pendingTasks: this.#pendingTasks,
        zone: this.#zone,
      }),
    ) as Query<TData, TError>
  }

  get<TData, TError = Error>(key: QueryKey): Query<TData, TError> | undefined {
    return this.getEntry(hashKey(key)) as Query<TData, TError> | undefined
  }

  /**
   * Like get(), but reactive, as findAll() is: a computed or an effect that
   * calls it re-runs when an entry is added or removed.
   */
  find<TData, TError = Error>(key: QueryKey): Query<TData, TError> | undefined {
    this.entries()

    return this.get<TData, TError>(key)
  }

  findAll(filters: QueryFilters = {}): Array<Query<unknown, unknown>> {
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

  // Generic: a query is invariant in TError (its observers' retry options take
  // the error as an argument), so a typed one isn't a Query<unknown, unknown>.
  remove<TData, TError>(query: Query<TData, TError>): void {
    // Guard on identity, not just the hash: a stale instance (already removed
    // and recreated under the same key) must not evict the current query.
    if (this.getEntry(query.queryHash) === query) {
      // Whoever removes it, gc or removeQueries, it leaves cleaned up: its
      // fetch cancelled and its gc timer cleared.
      query.destroy()
      this.removeEntry(query.queryHash)
    }
  }

  override clear(): void {
    this.getAll().forEach((query) => query.destroy())
    super.clear()
  }
}
