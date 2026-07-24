/*
 * Public API Surface of ngx-query
 */

export * from './lib/core/query-client'
export * from './lib/core/provider'
export * from './lib/core/inject-query-client'
export * from './lib/core/types'
export * from './lib/core/inject-query'
export * from './lib/core/inject-mutation'
export * from './lib/core/inject-is-fetching'
export * from './lib/core/inject-is-mutating'
export * from './lib/core/query-options'
export * from './lib/core/keep-previous-data'
export * from './lib/core/mutation-options'
export type {
  MutationFilters,
  MutationOptions,
  MutationResult,
  MutationState,
  MutationStatus,
} from './lib/core/mutation'
export { QueryClientFeatureKind } from './lib/features/feature'
export type { QueryClientFeature } from './lib/features/feature'
export { withDefaultOptions } from './lib/features/with-default-options'
export type {
  DefaultOptions,
  DefaultQueryOptions,
} from './lib/features/with-default-options'
