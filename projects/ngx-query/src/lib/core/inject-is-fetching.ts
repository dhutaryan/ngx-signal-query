import {
  assertInInjectionContext,
  computed,
  inject,
  Injector,
  Signal,
} from '@angular/core'

import { QueryClient } from './query-client'
import { QueryFilters } from './types'

export function injectIsFetching(
  filters?: QueryFilters,
  options?: { injector?: Injector },
): Signal<number> {
  if (!options?.injector) assertInInjectionContext(injectIsFetching)

  const client = options?.injector?.get(QueryClient) ?? inject(QueryClient)
  const cache = client.getQueryCache()

  return computed(
    () =>
      cache.findAll(filters).filter((query) => query.state().isFetching).length,
  )
}
