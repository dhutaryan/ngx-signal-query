import { InjectionToken } from '@angular/core'

export interface QueryClientConfig {
  defaultOptions?: {
    queries?: {
      staleTime?: number
      gcTime?: number
    }
  }
}

export const QUERY_CLIENT_CONFIG = new InjectionToken<QueryClientConfig>(
  'QUERY_CLIENT_CONFIG',
)
