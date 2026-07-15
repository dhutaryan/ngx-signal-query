import { InjectionToken } from '@angular/core'

import type { RetryDelayValue, RetryValue } from './types'

/** @internal */
export interface QueryClientConfig {
  defaultOptions?: {
    queries?: {
      staleTime?: number
      gcTime?: number
      retry?: RetryValue<unknown>
      retryDelay?: RetryDelayValue<unknown>
    }
  }
}

/** @internal */
export const QUERY_CLIENT_CONFIG = new InjectionToken<QueryClientConfig>(
  'QUERY_CLIENT_CONFIG',
)
