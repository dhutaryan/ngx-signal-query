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

    return this.addEntry(serializedKey, new Query(key, serializedKey)) as Query<
      TData,
      TError
    >
  }

  get<TData, TError = Error>(key: QueryKey): Query<TData, TError> | undefined {
    return this.getEntry(JSON.stringify(key)) as
      | Query<TData, TError>
      | undefined
  }

  override clear(): void {
    this.getAll().forEach((query) => query.cancel())
    super.clear()
  }
}
