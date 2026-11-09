import {
  type EnvironmentProviders,
  makeEnvironmentProviders,
} from '@angular/core'

import { QueryClient } from './query-client'
import { QueryCache } from './query-cache'
import { MutationCache } from './mutation-cache'
import {
  type QueryClientFeature,
  QueryClientFeatureKind,
} from '../features/feature'

/**
 * Registers the {@link QueryClient} and its caches for the application.
 *
 * Call once at the app root (in `ApplicationConfig.providers` or a root
 * `bootstrapApplication`). A client provided by another environment injector
 * goes with it: once that injector is destroyed, its queries stop, and none
 * of their fetches keeps the app busy, nor does anything started on the
 * client after that. A mutation already running finishes, and the app waits
 * for it. Pass features such as
 * {@link withDefaultOptions} to configure defaults, or {@link withHydration}
 * to bring the data of a server render over to the browser. Registering the
 * same feature twice throws.
 *
 * @param features - Optional {@link QueryClientFeature}s (e.g.
 *   {@link withDefaultOptions}, {@link withHydration}).
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
