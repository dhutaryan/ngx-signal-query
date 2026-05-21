import { InjectionToken } from '@angular/core'

import { QueryClientConfig } from './query-client'

export const QUERY_CLIENT_CONFIG = new InjectionToken<QueryClientConfig>(
  'QUERY_CLIENT_CONFIG',
)
