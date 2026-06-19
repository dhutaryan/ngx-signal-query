import {
  assertInInjectionContext,
  computed,
  inject,
  Injector,
  Signal,
} from '@angular/core'

import { QueryClient } from './query-client'
import { QueryFilters } from './types'

/**
 * Returns a signal with the number of queries currently fetching — useful for a
 * global loading indicator.
 *
 * Pass {@link QueryFilters} to count only matching queries; omit them to count
 * every fetching query in the cache.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @param filters - Optional filters (e.g. `{ queryKey: ['todos'] }`) to narrow
 *   the count.
 * @param options - Optional `injector` to use outside an injection context.
 * @returns A `Signal<number>` of active fetches.
 *
 * @example
 * ```ts
 * readonly isFetching = injectIsFetching()
 * // <app-spinner *ngIf="isFetching() > 0" />
 * ```
 */
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
