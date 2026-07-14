import { inject, Injectable } from '@angular/core'
import { queryOptions } from 'ngx-signal-query'

import { TodosApi } from './todos-api'

/**
 * Query definitions live next to the data they describe, so the key is written
 * exactly once and every call site — components, invalidation, cache writes —
 * takes it from here.
 */
@Injectable({ providedIn: 'root' })
export class TodoQueries {
  readonly #api = inject(TodosApi)

  public list() {
    return queryOptions({
      queryKey: ['todos'],
      queryFn: () => this.#api.list(),
      staleTime: 10_000,
    })
  }
}
