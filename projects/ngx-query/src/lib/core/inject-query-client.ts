import { inject } from '@angular/core'

import { QueryClient } from './query-client'

export function injectQueryClient(): QueryClient {
  return inject(QueryClient)
}
