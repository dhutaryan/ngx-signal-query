import { EnvironmentProviders, makeEnvironmentProviders } from '@angular/core'

import { QueryClient } from './query-client'
import { QueryCache } from './query-cache'
import { MutationCache } from './mutation-cache'
import { QueryClientFeature, QueryClientFeatureKind } from '../features/feature'

export function provideQueryClient(
  ...features: QueryClientFeature[]
): EnvironmentProviders {
  const seenKinds = new Set<QueryClientFeatureKind>()

  for (const feature of features) {
    if (seenKinds.has(feature.ɵkind)) {
      throw new Error(
        `provideQueryClient: feature "${QueryClientFeatureKind[feature.ɵkind]}" is registered more than once`,
      )
    }
    seenKinds.add(feature.ɵkind)
  }

  return makeEnvironmentProviders([
    QueryCache,
    MutationCache,
    QueryClient,
    ...features.flatMap((feature) => feature.ɵproviders),
  ])
}
