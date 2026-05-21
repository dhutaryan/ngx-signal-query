import { InjectionToken } from '@angular/core'

export interface QueryClientConfig {
  defaultOptions?: {
    queries?: {
      staleTime?: number
      gcTime?: number
      retry?: number
    }
  }
}

export const QUERY_CLIENT_CONFIG = new InjectionToken<QueryClientConfig>(
  'QUERY_CLIENT_CONFIG',
)
