import { inject, Injectable } from '@angular/core'
import { Observable } from 'rxjs'

import { QueryCache } from './query-cache'
import { MutationCache } from './mutation-cache'
import {
  DefaultedQueryOptions,
  QueryFilters,
  QueryKey,
  QueryOptions,
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
    }
  }

  fetchQuery<TData>(
    key: QueryKey,
    queryFn: () => Observable<TData>,
    staleTime = this.#config.defaultOptions?.queries?.staleTime ?? 0,
  ): void {
    const query = this.#cache.getOrCreate<TData>(key)

    if (query.shouldFetch(staleTime)) query.fetch(queryFn)
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
