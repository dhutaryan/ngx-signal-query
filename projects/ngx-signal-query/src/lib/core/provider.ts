import { EnvironmentProviders, makeEnvironmentProviders } from '@angular/core'

import { QueryClient } from './query-client'
import { QueryCache } from './query-cache'
import { MutationCache } from './mutation-cache'
import { QueryClientFeature, QueryClientFeatureKind } from '../features/feature'

/**
 * Registers the {@link QueryClient} and its caches for the application.
 *
 * Call once at the app root (in `ApplicationConfig.providers` or a root
 * `bootstrapApplication`). Pass features such as {@link withDefaultOptions} to
 * configure defaults. Registering the same feature twice throws.
 *
 * @param features - Optional {@link QueryClientFeature}s (e.g.
 *   {@link withDefaultOptions}).
 * @returns Environment providers to add to the app's provider list.
 *
 * @example
 * ```ts
 * export const appConfig: ApplicationConfig = {
 *   providers: [
 *     provideHttpClient(),
 *     provideQueryClient(
 *       withDefaultOptions({ queries: { staleTime: 30_000 } }),
 *     ),
 *   ],
 * }
 * ```
 */
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
