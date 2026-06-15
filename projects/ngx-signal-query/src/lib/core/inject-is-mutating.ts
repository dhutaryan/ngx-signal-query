import {
  assertInInjectionContext,
  computed,
  inject,
  Injector,
  Signal,
} from '@angular/core'

import { QueryClient } from './query-client'

export function injectIsMutating(options?: {
  injector?: Injector
}): Signal<number> {
  if (!options?.injector) assertInInjectionContext(injectIsMutating)

  const client = options?.injector?.get(QueryClient) ?? inject(QueryClient)
  const cache = client.getMutationCache()

  return computed(() => cache.findAll({ status: 'pending' }).length)
}
