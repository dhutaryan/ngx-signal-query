import { inject, Injectable, untracked } from '@angular/core'
import type { Observable } from 'rxjs'

import { QueryCache } from './query-cache'
import { MutationCache } from './mutation-cache'
import { defaultRetryDelay } from './retryer'
import { functionalUpdate } from './utils'
import type {
  DefaultedQueryOptions,
  QueryFilters,
  QueryKey,
  QueryOptions,
  RetryDelayValue,
  RetryValue,
  Updater,
} from './types'
import { QUERY_CLIENT_CONFIG } from './injection-tokens'

/**
 * Central registry and cache for queries and mutations.
 *
 * Provided by {@link provideQueryClient} and retrieved with
 * {@link injectQueryClient}. Offers imperative cache access — reading and
 * writing data, and invalidating, cancelling, or removing queries — that
 * complements the reactive {@link injectQuery} / {@link injectMutation} APIs.
 *
 * Its methods aren't reactive. Called from an effect, a method doesn't make
 * the effect depend on the cache, on a query's state, or on what `queryFn` or
 * an updater reads: the effect re-runs only when what it reads itself
 * changes. A read is a snapshot, in a template or a `computed` too; for state
 * that updates, use {@link injectQuery}, {@link injectIsFetching} and
 * {@link injectIsMutating}.
 */
@Injectable()
export class QueryClient {
  // Every method that reads or writes the cache runs its body untracked. A
  // call made from an effect mustn't make the effect depend on what the
  // method reads to do its job: the cache, a query's state, or what queryFn
  // or an updater reads. Otherwise a change to any of them re-runs the effect,
  // and the effect repeats the call.
  readonly #cache = inject(QueryCache)
  readonly #mutationCache = inject(MutationCache)
  readonly #config = inject(QUERY_CLIENT_CONFIG, { optional: true }) ?? {}

  /** Returns the underlying query cache. Advanced/internal use. */
  getQueryCache(): QueryCache {
    return this.#cache
  }

  /** Returns the underlying mutation cache. Advanced/internal use. */
  getMutationCache(): MutationCache {
    return this.#mutationCache
  }

  /**
   * Merges per-query options with the configured defaults, filling in
   * `staleTime`, `gcTime`, `retry`, and `retryDelay`. Used internally by
   * {@link injectQuery}.
   */
  defaultQueryOptions<TData, TError = Error>(
    options: QueryOptions<TData, TError>,
  ): DefaultedQueryOptions<TData, TError> {
    const defaults = this.#config.defaultOptions?.queries

    return {
      ...options,
      staleTime: options.staleTime ?? defaults?.staleTime ?? 0,
      gcTime: options.gcTime ?? defaults?.gcTime,
      retry: options.retry ?? defaults?.retry ?? 3,
      retryDelay:
        options.retryDelay ?? defaults?.retryDelay ?? defaultRetryDelay,
    }
  }

  /**
   * Imperatively fetches and caches a query, unless fresh data already exists
   * (governed by `staleTime`). Prefer {@link injectQuery} in components; use
   * this to prefetch, from an event handler or an effect.
   *
   * @param key - The query key to fetch and cache under.
   * @param queryFn - Function returning the data as an `Observable` or `Promise`.
   * @param options - Fetch tuning (`staleTime`, `retry`, `retryDelay`,
   *   `cancelRefetch`).
   */
  fetchQuery<TData>(
    key: QueryKey,
    queryFn: () => Observable<TData> | Promise<TData>,
    options: {
      staleTime?: number
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      retry?: RetryValue<any>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      retryDelay?: RetryDelayValue<any>
      cancelRefetch?: boolean
    } = {},
  ): void {
    untracked(() => {
      const defaults = this.#config.defaultOptions?.queries
      const staleTime = options.staleTime ?? defaults?.staleTime ?? 0
      const retry = options.retry ?? defaults?.retry ?? 3
      const retryDelay =
        options.retryDelay ?? defaults?.retryDelay ?? defaultRetryDelay

      const query = this.#cache.getOrCreate<TData>(key)

      if (query.shouldFetch(staleTime)) {
        query.fetch(queryFn, retry, retryDelay, options.cancelRefetch)
      }
    })
  }

  /**
   * Reads the current cached data for a query key, or `undefined` if the query
   * is not cached yet. A snapshot: it doesn't update a template, a `computed`
   * or an effect when the data changes. For data that updates, use
   * {@link injectQuery}.
   *
   * @param key - The query key to read.
   * @returns The cached data, or `undefined`.
   */
  getQueryData<TData>(key: QueryKey): TData | undefined {
    return untracked(() => this.#cache.get<TData>(key)?.state().data)
  }

  /**
   * Writes data into the cache for a query key, creating the entry if needed.
   * The `updater` may be a value or a function of the previous data; returning
   * `undefined` from the function is a no-op. Useful for optimistic updates.
   *
   * @param key - The query key to write.
   * @param updater - The new data, or a function `(prev) => next`.
   *
   * @example
   * ```ts
   * client.setQueryData<Todo[]>(['todos'], (prev = []) => [...prev, newTodo])
   * ```
   */
  setQueryData<TData>(
    key: QueryKey,
    updater: Updater<TData | undefined, TData>,
  ): void {
    untracked(() => {
      const query = this.#cache.getOrCreate<TData>(key)
      const data = functionalUpdate(updater, query.state().data)

      // Matches TanStack: an updater returning undefined is a no-op.
      if (data === undefined) return

      query.setData(data)
    })
  }

  /**
   * Marks matching queries as stale and refetches the actively observed ones,
   * once per query however many components observe it. The refetch starts
   * right away and replaces a fetch already in flight, which may predate the
   * change; this method doesn't wait for it. A query with no enabled observer
   * keeps the stale mark and refetches as soon as one appears. Commonly called
   * after a mutation succeeds.
   *
   * @param filters - Which queries to invalidate; omit to invalidate all.
   *
   * @example
   * ```ts
   * client.invalidateQueries({ queryKey: ['todos'] })
   * ```
   */
  invalidateQueries(filters?: QueryFilters): void {
    untracked(() => {
      const queries = this.#cache.findAll(filters)

      queries.forEach((query) => query.invalidate())

      // Refetch each active query once, however many observers watch it; an
      // inactive one refetches when next observed, as shouldFetch sees the
      // flag. cancelRefetch: a fetch already in flight started before the
      // invalidation, so it may have missed the change.
      queries.forEach((query) => {
        const options = query.activeFetchOptions()

        if (options) {
          query.fetch(options.queryFn, options.retry, options.retryDelay, true)
        }
      })
    })
  }

  /**
   * Cancels any in-flight fetches for matching queries.
   *
   * @param filters - Which queries to cancel; omit to cancel all.
   */
  cancelQueries(filters?: QueryFilters): void {
    untracked(() =>
      this.#cache.findAll(filters).forEach((query) => query.cancel()),
    )
  }

  /**
   * Removes matching queries from the cache entirely, discarding their data.
   *
   * @param filters - Which queries to remove; omit to remove all.
   */
  removeQueries(filters?: QueryFilters): void {
    untracked(() =>
      this.#cache.findAll(filters).forEach((query) => {
        query.destroy()
        this.#cache.remove(query)
      }),
    )
  }

  /**
   * Returns the number of matching queries currently fetching. A snapshot: it
   * doesn't update a template, a `computed` or an effect. For a count that
   * updates, use {@link injectIsFetching}.
   *
   * @param filters - Which queries to count; omit to count all.
   */
  isFetching(filters?: QueryFilters): number {
    return untracked(() => {
      const fetching = this.#cache
        .findAll(filters)
        .filter((query) => query.state().isFetching)

      return fetching.length
    })
  }

  /**
   * Returns the number of mutations currently pending. A snapshot: it doesn't
   * update a template, a `computed` or an effect. For a count that updates,
   * use {@link injectIsMutating}.
   */
  isMutating(): number {
    return untracked(
      () => this.#mutationCache.findAll({ status: 'pending' }).length,
    )
  }
}
