import { QUERY_CLIENT_CONFIG } from '../core/injection-tokens'
import {
  QueryClientFeature,
  QueryClientFeatureKind,
  queryClientFeature,
} from './feature'

export interface DefaultQueryOptions {
  staleTime?: number
  gcTime?: number
}

export interface DefaultOptions {
  queries?: DefaultQueryOptions
}

export function withDefaultOptions(
  options: DefaultOptions,
): QueryClientFeature<QueryClientFeatureKind.DefaultOptions> {
  return queryClientFeature(QueryClientFeatureKind.DefaultOptions, [
    { provide: QUERY_CLIENT_CONFIG, useValue: { defaultOptions: options } },
  ])
}
