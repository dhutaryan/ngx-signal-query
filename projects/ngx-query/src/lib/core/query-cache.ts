import { Injectable } from '@angular/core'

import { Cache } from './cache'
import { Query } from './query'
import { QueryKey } from './types'

@Injectable()
export class QueryCache extends Cache<Query<unknown, unknown>> {
  getOrCreate<TData, TError = Error>(key: QueryKey): Query<TData, TError> {
    const serializedKey = JSON.stringify(key)
    const exist = this.getEntry(serializedKey)

    if (exist) return exist as Query<TData, TError>

    return this.addEntry(
      serializedKey,
      new Query(serializedKey, this),
    ) as Query<TData, TError>
  }

  get<TData, TError = Error>(key: QueryKey): Query<TData, TError> | undefined {
    return this.getEntry(JSON.stringify(key)) as
      | Query<TData, TError>
      | undefined
  }

  remove(query: Query<unknown, unknown>): void {
    this.removeEntry(query.serializedKey)
  }

  override clear(): void {
    this.getAll().forEach((query) => query.destroy())
    super.clear()
  }
}
