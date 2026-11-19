import { QUERY_CACHE_CONFIG } from '../core/injection-tokens'
import type { QuerySnapshot } from '../core/types'
import {
  type QueryClientFeature,
  QueryClientFeatureKind,
  queryClientFeature,
} from './feature'

/**
 * Callbacks for every query in the cache, set with {@link withQueryCache}.
 * Each gets the query as a {@link QuerySnapshot}. The data and the error are
 * typed `unknown`: one callback serves every query, whatever its types.
 */
export type QueryCacheConfig = {
  /** Runs when a fetch of a query lands, with its data. */
  onSuccess?: (data: unknown, query: QuerySnapshot) => unknown
  /**
   * Runs when a fetch of a query fails for good, after its retries, with the
   * error. The query keeps the data it had, if any.
   */
  onError?: (error: unknown, query: QuerySnapshot) => unknown
  /**
   * Runs after `onSuccess` or `onError`: with the data and `null`, or with
   * the data the query keeps and the error.
   */
  onSettled?: (data: unknown, error: unknown, query: QuerySnapshot) => unknown
}

/**
 * Feature for {@link provideQueryClient} that sets callbacks for every query
 * in the cache. A fetch of a query calls them once it ends: `onSuccess` or
 * `onError`, then `onSettled`. A failure calls `onError` once, after the
 * retries, and a fetch that several components share calls them once. They
 * run whatever started the fetch: a component, `query()`, an invalidation or
 * polling. Unlike a default option, a query's own options don't replace
 * them.
 *
 * A fetch that stops before it ends calls none: one that's cancelled or
 * replaced, one whose query is removed, and one stopped once no component
 * shows the query any more (see `queryFn` in {@link QueryOptions}). Neither
 * does data that `setQueryData()` or `initialData` writes.
 *
 * They run in the injection context of the injector that provides the
 * client, so they can call `inject()` before their first `await`; once the
 * app is torn down, they no longer run. With zone.js, they run in Angular's
 * zone when the fetch was asked for from there, such as by a component, and
 * outside it otherwise, such as for a poll. An error a callback throws, or a
 * promise it returns that rejects, goes to the app's `ErrorHandler`: the
 * fetch's outcome stands, and the next callback still runs. Nothing waits
 * for a promise a callback returns, so one that rejects once the app is torn
 * down, after a server render say, surfaces as an unhandled rejection: the
 * app's `ErrorHandler` is gone by then.
 *
 * @param config - The {@link QueryCacheConfig} callbacks.
 * @returns A {@link QueryClientFeature} to pass to {@link provideQueryClient}.
 *
 * @example
 * ```ts
 * provideQueryClient(
 *   withQueryCache({
 *     onError: (error) => inject(ErrorHandler).handleError(error),
 *   }),
 * )
 * ```
 */
export function withQueryCache(
  config: QueryCacheConfig,
): QueryClientFeature<QueryClientFeatureKind.QueryCache> {
  return queryClientFeature(QueryClientFeatureKind.QueryCache, [
    { provide: QUERY_CACHE_CONFIG, useValue: config },
  ])
}
