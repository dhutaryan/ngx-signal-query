import { inject, Injectable } from '@angular/core'
import { Observable } from 'rxjs'

import { QueryCache } from './query-cache'
import { QueryKey } from './types'
import { QUERY_CLIENT_CONFIG } from './injection-tokens'
import { Query } from './query'

export interface QueryClientConfig {
  defaultOptions?: {
    queries?: {
      staleTime?: number
      retry?: number
    }
  }
}

@Injectable()
export class QueryClient {
  readonly #cache = inject(QueryCache)
  readonly #config = inject(QUERY_CLIENT_CONFIG, { optional: true }) ?? {}

  getOrCreateQuery<TData, TError = Error>(key: QueryKey): Query<TData, TError> {
    return this.#cache.getOrCreate<TData, TError>(key)
  }

  fetchQuery<TData>(
    key: QueryKey,
    queryFn: () => Observable<TData>,
    staleTime = this.#config.defaultOptions?.queries?.staleTime ?? 0,
  ): void {
    const query = this.#cache.getOrCreate<TData>(key)
    const state = query.state()

    if (state.status === 'success' && !query.isStale(staleTime)) return

    query.fetch(queryFn)
  }

  getQueryData<TData>(key: QueryKey): TData | undefined {
    return this.#cache.get<TData>(key)?.state().data
  }

  setQueryData<TData>(key: QueryKey, data: TData): void {
    const query = this.#cache.getOrCreate<TData>(key)
    query.state.update((state) => ({
      ...state,
      data,
      status: 'success',
      updatedAt: Date.now(),
    }))
  }

  invalidateQueries(key: QueryKey): void {
    const query = this.#cache.get(key)

    if (!query) return

    query.state.update((state) => ({ ...state, updatedAt: 0 }))
  }

  getDefaultOptions() {
    return this.#config.defaultOptions
  }
}
