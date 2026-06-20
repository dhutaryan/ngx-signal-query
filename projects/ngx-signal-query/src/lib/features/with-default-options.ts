import { QUERY_CLIENT_CONFIG } from '../core/injection-tokens'
import type { RetryDelayValue, RetryValue } from '../core/types'
import {
  type QueryClientFeature,
  QueryClientFeatureKind,
  queryClientFeature,
} from './feature'

/** Default query options applied to every query unless overridden per-query. */
export interface DefaultQueryOptions {
  /** How long fetched data is considered fresh, in ms. Defaults to `0`. */
  staleTime?: number
  /** How long unused (unobserved) data is kept before garbage collection, in ms. */
  gcTime?: number
  /** Retry policy on failure: a boolean, a count, or a predicate. Defaults to `3`. */
  retry?: RetryValue<unknown>
  /** Delay between retries, in ms or a function of the attempt. */
  retryDelay?: RetryDelayValue<unknown>
}

/** Application-wide defaults configured via {@link withDefaultOptions}. */
export interface DefaultOptions {
  /** Defaults applied to all queries. */
  queries?: DefaultQueryOptions
}

/**
 * Feature for {@link provideQueryClient} that sets application-wide default
 * query options. Per-query options always take precedence over these defaults.
 *
 * @param options - The {@link DefaultOptions} to apply.
 * @returns A {@link QueryClientFeature} to pass to {@link provideQueryClient}.
 *
 * @example
 * ```ts
 * provideQueryClient(
 *   withDefaultOptions({ queries: { staleTime: 60_000, retry: 1 } }),
 * )
 * ```
 */
export function withDefaultOptions(
  options: DefaultOptions,
): QueryClientFeature<QueryClientFeatureKind.DefaultOptions> {
  return queryClientFeature(QueryClientFeatureKind.DefaultOptions, [
    { provide: QUERY_CLIENT_CONFIG, useValue: { defaultOptions: options } },
  ])
}
