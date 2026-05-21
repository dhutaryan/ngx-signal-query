import { EnvironmentProviders, makeEnvironmentProviders } from '@angular/core'

import { QueryClient, QueryClientConfig } from './query-client'
import { QueryCache } from './query-cache'
import { QUERY_CLIENT_CONFIG } from './injection-tokens'

export function provideQueryClient(config?: QueryClientConfig) {
  return makeEnvironmentProviders([
    QueryCache,
    QueryClient,
    {
      provide: QUERY_CLIENT_CONFIG,
      useValue: config ?? {},
    },
  ])
}
