import { inject, Injectable } from '@angular/core'
import { Observable } from 'rxjs'

import { QueryCache } from './query-cache'
import { MutationCache } from './mutation-cache'
import { defaultRetryDelay } from './retryer'
import {
  DefaultedQueryOptions,
  QueryFilters,
  QueryKey,
  QueryOptions,
  RetryDelayValue,
  RetryValue,
} from './types'
import { QUERY_CLIENT_CONFIG } from './injection-tokens'

@Injectable()
export class QueryClient {
  readonly #cache = inject(QueryCache)
  readonly #mutationCache = inject(MutationCache)
  readonly #config = inject(QUERY_CLIENT_CONFIG, { optional: true }) ?? {}

  getQueryCache(): QueryCache {
    return this.#cache
  }

  getMutationCache(): MutationCache {
    return this.#mutationCache
  }

  defaultQueryOptions<TData, TError = Error>(
    options: QueryOptions<TData, TError>,
  ): DefaultedQueryOptions<TData, TError> {
    const defaults = this.#config.defaultOptions?.queries

    return {
      ...options,
      staleTime: options.staleTime ?? defaults?.staleTime ?? 0,
      gcTime: options.gcTime ?? defaults?.gcTime,
      retry: options.retry ?? defaults?.retry ?? 3,
      retryDelay: options.retryDelay ?? defaults?.retryDelay ?? defaultRetryDelay,
    }
  }

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
    const retryDelay = options.retryDelay ?? defaults?.retryDelay ?? defaultRetryDelay

    const query = this.#cache.getOrCreate<TData>(key)

    if (query.shouldFetch(staleTime)) {
      query.fetch(queryFn, retry, retryDelay, options.cancelRefetch)
    }
  }

  getQueryData<TData>(key: QueryKey): TData | undefined {
    return this.#cache.get<TData>(key)?.state().data
  }

  setQueryData<TData>(key: QueryKey, data: TData): void {
    this.#cache.getOrCreate<TData>(key).setData(data)
  }

  invalidateQueries(filters?: QueryFilters): void {
    this.#cache.findAll(filters).forEach((query) => query.invalidate())
  }

  isFetching(filters?: QueryFilters): number {
    return this.#cache.findAll(filters).filter((query) => query.state().isFetching)
      .length
  }

  isMutating(): number {
    return this.#mutationCache.findAll({ status: 'pending' }).length
  }
}
