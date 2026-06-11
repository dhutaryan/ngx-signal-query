import {
  assertInInjectionContext,
  computed,
  effect,
  inject,
  Injector,
  runInInjectionContext,
  signal,
  untracked,
} from '@angular/core'

import { QueryClient } from './query-client'
import { QueryOptions, QueryResult } from './types'

export function injectQuery<TData, TError = Error>(
  optionsFn: () => QueryOptions<TData, TError>,
  options?: { injector?: Injector },
): QueryResult<TData, TError> {
  if (!options?.injector) assertInInjectionContext(injectQuery)

  const injector = options?.injector ?? inject(Injector)

  return runInInjectionContext(injector, () => {
    const client = inject(QueryClient)

    // Single source of truth for defaulted options; resolves config defaults
    // (staleTime, gcTime) once instead of scattering the logic across effects.
    const defaultedOptions = computed(() =>
      client.defaultQueryOptions(optionsFn()),
    )

    // getOrCreateQuery mutates the cache (a side effect), so it must not run
    // inside a computed. Resolve the query in a signal: seed it synchronously
    // and update it from an effect whenever the key changes.
    const query = signal(
      client.getOrCreateQuery<TData, TError>(
        untracked(defaultedOptions).queryKey,
      ),
    )

    effect(() => {
      const key = defaultedOptions().queryKey
      query.set(untracked(() => client.getOrCreateQuery<TData, TError>(key)))
    })

    // Memoized: only emits when the flag itself flips, so ordinary data
    // updates don't wake the fetch effect (no refetch loop).
    const isInvalidated = computed(() => query().state().isInvalidated)

    effect((cleanup) => {
      const q = query()
      const { gcTime } = untracked(defaultedOptions)

      if (gcTime !== undefined) {
        q.setGcTime(gcTime)
      }

      q.addObserver()
      cleanup(() => q.removeObserver())
    })

    effect(() => {
      const { queryKey, queryFn, staleTime, enabled } = defaultedOptions()

      // Track invalidation so invalidateQueries() re-triggers a refetch.
      isInvalidated()

      if (enabled === false) return

      untracked(() => client.fetchQuery(queryKey, queryFn, staleTime))
    })

    return {
      data: computed(() => query().state().data),
      status: computed(() => query().state().status),
      error: computed(() => query().state().error as TError | null),
      isFetching: computed(() => query().state().isFetching),
      isPending: computed(() => query().state().status === 'pending'),
      isSuccess: computed(() => query().state().status === 'success'),
      isError: computed(() => query().state().status === 'error'),
    }
  })
}
