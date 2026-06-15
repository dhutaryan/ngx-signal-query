import { assertInInjectionContext, inject, Injector } from '@angular/core'

import { QueryClient } from './query-client'

export function injectQueryClient(options?: {
  injector?: Injector
}): QueryClient {
  if (!options?.injector) assertInInjectionContext(injectQueryClient)

  return options?.injector?.get(QueryClient) ?? inject(QueryClient)
}
