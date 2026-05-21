import { Injectable } from '@angular/core'

import { Cache } from './cache'
import { hashKey } from './utils'
import { Query } from './query'
import { QueryKey } from './types'

@Injectable()
export class QueryCache extends Cache<Query<unknown, unknown>> {
  getOrCreate<TData, TError = Error>(key: QueryKey): Query<TData, TError> {
    const queryHash = hashKey(key)
    const exist = this.getEntry(queryHash)

    if (exist) return exist as Query<TData, TError>

    return this.addEntry(queryHash, new Query(queryHash, this)) as Query<
      TData,
      TError
    >
  }

  get<TData, TError = Error>(key: QueryKey): Query<TData, TError> | undefined {
    return this.getEntry(hashKey(key)) as Query<TData, TError> | undefined
  }

  remove(query: Query<unknown, unknown>): void {
    this.removeEntry(query.queryHash)
  }

  override clear(): void {
    this.getAll().forEach((query) => query.destroy())
    super.clear()
  }
}
