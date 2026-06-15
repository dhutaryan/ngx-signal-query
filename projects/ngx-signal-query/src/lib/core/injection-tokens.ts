import { InjectionToken } from '@angular/core'

import { RetryDelayValue, RetryValue } from './types'

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

export const QUERY_CLIENT_CONFIG = new InjectionToken<QueryClientConfig>(
  'QUERY_CLIENT_CONFIG',
)
