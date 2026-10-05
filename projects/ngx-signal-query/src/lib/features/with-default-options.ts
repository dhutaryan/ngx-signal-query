import { QUERY_CLIENT_CONFIG } from '../core/injection-tokens'
import type { DefaultOptions } from '../core/types'
import {
  type QueryClientFeature,
  QueryClientFeatureKind,
  queryClientFeature,
} from './feature'

/**
 * Feature for {@link provideQueryClient} that sets application-wide default
 * query and mutation options. A query's or mutation's own options take
 * precedence, field by field.
 *
 * @param options - The {@link DefaultOptions} to apply.
 * @returns A {@link QueryClientFeature} to pass to {@link provideQueryClient}.
 *
 * @example
 * ```ts
 * provideQueryClient(
 *   withDefaultOptions({
 *     queries: { staleTime: 60_000, retry: 1 },
 *     mutations: {
 *       onError: (error) => inject(ErrorHandler).handleError(error),
 *     },
 *   }),
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
