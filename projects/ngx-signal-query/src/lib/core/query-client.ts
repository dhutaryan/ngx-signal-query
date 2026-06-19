import { inject, Injectable } from '@angular/core'
import { Observable } from 'rxjs'

import { QueryCache } from './query-cache'
import { MutationCache } from './mutation-cache'
import { defaultRetryDelay } from './retryer'
import { functionalUpdate } from './utils'
import {
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
 */
@Injectable()
export class QueryClient {
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
   * this for prefetching outside the reactive flow.
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
    const defaults = this.#config.defaultOptions?.queries
    const staleTime = options.staleTime ?? defaults?.staleTime ?? 0
    const retry = options.retry ?? defaults?.retry ?? 3
    const retryDelay =
      options.retryDelay ?? defaults?.retryDelay ?? defaultRetryDelay

    const query = this.#cache.getOrCreate<TData>(key)

    if (query.shouldFetch(staleTime)) {
      query.fetch(queryFn, retry, retryDelay, options.cancelRefetch)
    }
  }

  /**
   * Reads the current cached data for a query key, or `undefined` if the query
   * is not cached yet.
   *
   * @param key - The query key to read.
   * @returns The cached data, or `undefined`.
   */
  getQueryData<TData>(key: QueryKey): TData | undefined {
    return this.#cache.get<TData>(key)?.state().data
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
    const query = this.#cache.getOrCreate<TData>(key)
    const data = functionalUpdate(updater, query.state().data)

    // Matches TanStack: an updater returning undefined is a no-op.
    if (data === undefined) return

    query.setData(data)
  }

  /**
   * Marks matching queries as stale and triggers a refetch for those that are
   * actively observed. Commonly called after a mutation succeeds.
   *
   * @param filters - Which queries to invalidate; omit to invalidate all.
   *
   * @example
   * ```ts
   * client.invalidateQueries({ queryKey: ['todos'] })
   * ```
   */
  invalidateQueries(filters?: QueryFilters): void {
    this.#cache.findAll(filters).forEach((query) => query.invalidate())
  }

  /**
   * Cancels any in-flight fetches for matching queries.
   *
   * @param filters - Which queries to cancel; omit to cancel all.
   */
  cancelQueries(filters?: QueryFilters): void {
    this.#cache.findAll(filters).forEach((query) => query.cancel())
  }

  /**
   * Removes matching queries from the cache entirely, discarding their data.
   *
   * @param filters - Which queries to remove; omit to remove all.
   */
  removeQueries(filters?: QueryFilters): void {
    this.#cache.findAll(filters).forEach((query) => {
      query.destroy()
      this.#cache.remove(query)
    })
  }

  /**
   * Returns the number of matching queries currently fetching. For a reactive
   * count, prefer {@link injectIsFetching}.
   *
   * @param filters - Which queries to count; omit to count all.
   */
  isFetching(filters?: QueryFilters): number {
    return this.#cache
      .findAll(filters)
      .filter((query) => query.state().isFetching).length
  }

  /**
   * Returns the number of mutations currently pending. For a reactive count,
   * prefer {@link injectIsMutating}.
   */
  isMutating(): number {
    return this.#mutationCache.findAll({ status: 'pending' }).length
  }
}
