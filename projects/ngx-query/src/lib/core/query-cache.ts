import { Injectable } from '@angular/core'

import { Query } from './query'
import { QueryKey } from './types'

@Injectable()
export class QueryCache {
  readonly #cache = new Map<string, Query<unknown, unknown>>()

  getOrCreate<TData, TError = Error>(key: QueryKey): Query<TData, TError> {
    const serializedKey = JSON.stringify(key)

    if (!this.#cache.has(serializedKey)) {
      this.#cache.set(serializedKey, new Query(key, serializedKey))
    }

    return this.#cache.get(serializedKey) as Query<TData, TError>
  }

  get<TData, TError = Error>(key: QueryKey): Query<TData, TError> | undefined {
    return this.#cache.get(JSON.stringify(key)) as
      | Query<TData, TError>
      | undefined
  }

  clear(): void {
    this.#cache.forEach((query) => query.cancel())
    this.#cache.clear()
  }
}
