import { QUERY_CLIENT_HYDRATION } from '../core/injection-tokens'
import {
  type QueryClientFeature,
  QueryClientFeatureKind,
  queryClientFeature,
} from './feature'

/**
 * Feature for {@link provideQueryClient} that brings the data a server render
 * fetched over to the browser, so the page shows it at once rather than a
 * loading state. Add it to the providers the server and the browser share. It
 * works with Angular's `provideClientHydration()` or without it.
 *
 * Only queries that succeeded go over, and only data JSON carries as is:
 * strings, numbers, booleans, `null`, plain objects and arrays. A query whose
 * data holds a `Date`, a `Map` or a class instance stays on the server, and
 * the browser fetches it again; in development the server logs a warning
 * naming it.
 *
 * In the browser the data counts as fetched when the server fetched it, and
 * `staleTime` decides as for any data in the cache: with the default of `0`,
 * a component refetches its query in the background as it appears, showing
 * the server's data meanwhile. Set a `staleTime` to skip that request.
 *
 * Give it to one client per app: clients provided by other environment
 * injectors would share one place in the page, and only one of them would get
 * its data over.
 *
 * @returns A {@link QueryClientFeature} to pass to {@link provideQueryClient}.
 *
 * @example
 * ```ts
 * export const appConfig: ApplicationConfig = {
 *   providers: [
 *     provideQueryClient(
 *       withDefaultOptions({ queries: { staleTime: 30_000 } }),
 *       withHydration(),
 *     ),
 *   ],
 * }
 * ```
 */
export function withHydration(): QueryClientFeature<QueryClientFeatureKind.Hydration> {
  return queryClientFeature(QueryClientFeatureKind.Hydration, [
    { provide: QUERY_CLIENT_HYDRATION, useValue: true },
  ])
}
