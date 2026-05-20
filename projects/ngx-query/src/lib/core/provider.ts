import { EnvironmentProviders, makeEnvironmentProviders } from '@angular/core'

import { QueryClient } from './query-client'

export function provideQueryClient(): EnvironmentProviders {
  return makeEnvironmentProviders([QueryClient])
}
