import {
  type Injector,
  type Signal,
  assertInInjectionContext,
  computed,
  inject,
} from '@angular/core'

import { QueryClient } from './query-client'
import type { QueryFilters } from './types'

/**
 * Returns a signal with the number of queries currently fetching — useful for a
 * global loading indicator.
 *
 * Pass {@link QueryFilters} to count only matching queries; omit them to count
 * every fetching query in the cache. Pass a function that returns them when
 * they read a signal or an input.
 *
 * A fetch whose `queryFn` returns a Promise without reading the signal it's
 * given counts until it ends, even after the last component showing its key
 * is gone: nothing can abort that request, so the fetch runs on and its
 * response is cached.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @param filters - Optional filters (e.g. `{ queryKey: ['todos'] }`) to narrow
 *   the count, or a function that returns them, called inside the signal's
 *   computation, the way {@link injectQuery} calls its options, so the
 *   filters can use a signal or an input.
 * @param options - Optional `injector` to use outside an injection context.
 * @returns A `Signal<number>` of active fetches.
 *
 * @example
 * ```ts
 * readonly isFetching = injectIsFetching()
 * // <p>{{ isFetching() > 0 ? 'Loading…' : '' }}</p>
 *
 * // The fetches of one todo, with an input in the key:
 * readonly id = input.required<number>()
 * readonly loading = injectIsFetching(() => ({ queryKey: ['todo', this.id()] }))
 * ```
 */
export function injectIsFetching(
  filters?: QueryFilters | (() => QueryFilters),
  options?: { injector?: Injector },
): Signal<number> {
  if (!options?.injector) assertInInjectionContext(injectIsFetching)

  const client = options?.injector?.get(QueryClient) ?? inject(QueryClient)
  const cache = client.getQueryCache()

  return computed(() => {
    // Filters given as a function are called here, in the computed, so the
    // count follows the signals they read.
    const current = typeof filters === 'function' ? filters() : filters
    const fetching = cache
      .findAll(current)
      .filter((query) => query.state().isFetching)

    return fetching.length
  })
}
