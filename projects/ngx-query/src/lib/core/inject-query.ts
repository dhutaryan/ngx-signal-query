import { computed, effect, inject, untracked } from '@angular/core'

import { QueryClient } from './query-client'
import { QueryOptions, QueryResult } from './types'

export function injectQuery<TData, TError = Error>(
  optionsFn: () => QueryOptions<TData, TError>,
): QueryResult<TData, TError> {
  const client = inject(QueryClient)

  const query = computed(() => {
    const { queryKey } = optionsFn()

    return client.getOrCreateQuery<TData, TError>(queryKey)
  })

  effect(() => {
    const { queryKey, queryFn, staleTime, enabled } = optionsFn()

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
}
